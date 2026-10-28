-- PRELUX · Etapa 2: capacidade por posição, prazos lineares e ajustes manuais
-- Migração incremental: mantém production_schedules como resumo legado e grava
-- a programação detalhada em production_orders + allocations.

begin;

alter table public.orders
  add column if not exists planned_start_date date,
  add column if not exists forecast_end_date date;

create table if not exists public.mold_positions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code in ('P01','P02','P03','P04')),
  status text not null default 'disponivel'
    check (status in ('disponivel','em_preparacao','em_producao','em_manutencao')),
  notes text,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

insert into public.mold_positions (organization_id, code)
select o.id, p.code
from public.organizations o
cross join (values ('P01'),('P02'),('P03'),('P04')) as p(code)
where o.is_active = true
on conflict (organization_id, code) do nothing;

create table if not exists public.production_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  unit_sequence integer not null check (unit_sequence > 0),
  planned_cast_date date not null,
  planned_cure_start_date date not null,
  planned_cure_end_date date not null,
  planned_finish_date date not null,
  planned_end_date date not null,
  forecast_end_date date not null,
  curing_days smallint not null default 2 check (curing_days > 0),
  production_minutes_snapshot integer not null default 0 check (production_minutes_snapshot >= 0),
  status text not null default 'planned'
    check (status in ('planned','in_progress','done','cancelled','scrapped')),
  notes text,
  created_at timestamptz not null default now(),
  check (planned_cure_start_date = planned_cast_date + 1),
  check (planned_cure_end_date = planned_cast_date + curing_days),
  check (planned_finish_date >= planned_cure_end_date),
  check (planned_end_date = planned_finish_date)
);

create index if not exists production_orders_queue_idx
  on public.production_orders (organization_id, planned_cast_date, order_id, order_item_id, unit_sequence)
  where status <> 'cancelled';
create index if not exists production_orders_end_idx
  on public.production_orders (organization_id, planned_end_date, status);
create unique index if not exists production_orders_item_sequence_active_idx
  on public.production_orders (order_item_id, unit_sequence)
  where status <> 'cancelled';

create table if not exists public.allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  production_order_id uuid not null references public.production_orders(id) on delete cascade,
  mold_position_id uuid not null references public.mold_positions(id) on delete restrict,
  scheduled_date date not null,
  assigned_at timestamptz,
  released_at timestamptz,
  assigned_by text,
  released_by text,
  release_reason text,
  status text not null default 'planned'
    check (status in ('planned','in_progress','done','cancelled')),
  notes text,
  check (released_at is null or assigned_at is null or released_at >= assigned_at)
);

create unique index if not exists allocations_one_active_unit_idx
  on public.allocations (production_order_id)
  where status in ('planned','in_progress');
create unique index if not exists allocations_one_active_position_day_idx
  on public.allocations (mold_position_id, scheduled_date)
  where status in ('planned','in_progress');
create index if not exists allocations_calendar_idx
  on public.allocations (organization_id, scheduled_date, mold_position_id, status);

create table if not exists public.delay_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  reason text not null,
  occurred_on date not null,
  impact_days integer not null check (impact_days <> 0),
  previous_forecast_end date not null,
  adjusted_forecast_end date not null,
  recorded_by text,
  created_at timestamptz not null default now(),
  check (adjusted_forecast_end - previous_forecast_end = impact_days)
);
create index if not exists delay_adjustments_order_date_idx
  on public.delay_adjustments (organization_id, order_id, occurred_on);

alter table public.mold_positions enable row level security;
alter table public.production_orders enable row level security;
alter table public.allocations enable row level security;
alter table public.delay_adjustments enable row level security;

-- Impede que a edição do pedido apague a rastreabilidade de unidades que já
-- começaram ou terminaram a produção.
create or replace function public.guard_started_production_order_item_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.production_orders po
    where po.order_item_id = old.id and po.status in ('in_progress','done','scrapped')
  ) or exists (
    select 1 from public.allocations a
    join public.production_orders po on po.id = a.production_order_id
    where po.order_item_id = old.id and a.status in ('in_progress','done')
  ) then
    raise exception 'Item com produção iniciada ou concluída não pode ser removido.';
  end if;
  return old;
end;
$$;

drop trigger if exists guard_started_production_order_item_delete on public.order_items;
create trigger guard_started_production_order_item_delete
before delete on public.order_items
for each row execute function public.guard_started_production_order_item_delete();

create or replace function public.commit_order_plan(
  p_org_id uuid,
  p_order_id uuid,
  p_plan jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  unit_row jsonb;
  item_id uuid;
  v_piece_type_id uuid;
  position_id uuid;
  production_order_id uuid;
  unit_sequence integer;
  schedule_count integer := 0;
  allocation_count integer := 0;
  planned_end date;
  planned_start date;
  forecast_end date;
  requested_due date;
  adjustment_days integer;
begin
  if p_plan is null or jsonb_typeof(p_plan->'units') is distinct from 'array' then
    raise exception 'Plano inválido: units precisa ser uma lista';
  end if;
  if not exists (
    select 1 from public.orders
    where id = p_order_id and organization_id = p_org_id and is_active = true
  ) then
    raise exception 'Pedido não encontrado';
  end if;
  if exists (
    select 1 from public.production_schedules
    where organization_id = p_org_id and order_id = p_order_id and status in ('in_progress','done')
  ) or exists (
    select 1 from public.production_orders
    where organization_id = p_org_id and order_id = p_order_id and status in ('in_progress','done','scrapped')
  ) or exists (
    select 1 from public.allocations a
    join public.production_orders po on po.id = a.production_order_id
    where po.organization_id = p_org_id and po.order_id = p_order_id
      and a.status in ('in_progress','done')
  ) then
    raise exception 'Pedido com produção iniciada ou concluída não pode ser replanejado.';
  end if;

  delete from public.allocations a
  using public.production_orders po
  where a.production_order_id = po.id
    and po.organization_id = p_org_id
    and po.order_id = p_order_id
    and a.status = 'planned';
  delete from public.production_orders
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';
  delete from public.production_schedules
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';

  for unit_row in select value from jsonb_array_elements(p_plan->'units')
  loop
    item_id := nullif(unit_row->>'itemId', '')::uuid;
    v_piece_type_id := nullif(unit_row->>'pieceTypeId', '')::uuid;
    unit_sequence := nullif(unit_row->>'unitSequence', '')::integer;

    if item_id is null or unit_sequence is null or unit_sequence < 1 then
      raise exception 'Unidade programada sem item ou sequência válida.';
    end if;
    if not exists (
      select 1 from public.order_items oi
      where id = item_id and organization_id = p_org_id and order_id = p_order_id
        and oi.piece_type_id = v_piece_type_id
    ) then
      raise exception 'Item da programação não pertence ao pedido informado.';
    end if;
    if not exists (
      select 1 from public.calendar_days cd
      where cd.organization_id = p_org_id
        and cd.date = (unit_row->>'castDate')::date
        and cd.is_working = true
    ) then
      raise exception 'A concretagem precisa ocorrer em um dia útil do calendário.';
    end if;
    select id into position_id from public.mold_positions
      where organization_id = p_org_id and code = unit_row->>'positionCode'
        and status <> 'em_manutencao';
    if position_id is null then
      raise exception 'Posição de molde inexistente ou em manutenção.';
    end if;

    insert into public.production_orders (
      organization_id, order_id, order_item_id, unit_sequence,
      planned_cast_date, planned_cure_start_date, planned_cure_end_date,
      planned_finish_date, planned_end_date, forecast_end_date,
      curing_days, production_minutes_snapshot, status
    ) values (
      p_org_id, p_order_id, item_id, unit_sequence,
      (unit_row->>'castDate')::date,
      (unit_row->>'cureStartDate')::date,
      (unit_row->>'cureEndDate')::date,
      (unit_row->>'finishDate')::date,
      (unit_row->>'plannedEndDate')::date,
      (unit_row->>'plannedEndDate')::date,
      (unit_row->>'curingDays')::smallint,
      coalesce((unit_row->>'productionMinutesSnapshot')::integer, 0),
      'planned'
    ) returning id into production_order_id;

    insert into public.allocations (
      organization_id, production_order_id, mold_position_id, scheduled_date, status
    ) values (
      p_org_id, production_order_id, position_id, (unit_row->>'castDate')::date, 'planned'
    );
    allocation_count := allocation_count + 1;
  end loop;

  -- Resumo agregado compatível com a tela atual. Minutos são registro, não capacidade.
  insert into public.production_schedules (
    organization_id, order_id, order_item_id, piece_type_id,
    work_date, planned_quantity, planned_minutes, status
  )
  select
    p_org_id, po.order_id, po.order_item_id, oi.piece_type_id,
    po.planned_cast_date, count(*)::integer,
    sum(po.production_minutes_snapshot)::integer, 'planned'
  from public.production_orders po
  join public.order_items oi on oi.id = po.order_item_id
  where po.organization_id = p_org_id and po.order_id = p_order_id and po.status = 'planned'
  group by po.order_id, po.order_item_id, oi.piece_type_id, po.planned_cast_date;
  get diagnostics schedule_count = row_count;

  planned_start := nullif(p_plan->>'effectiveStartDate', '')::date;
  planned_end := nullif(p_plan->>'plannedEndDate', '')::date;
  requested_due := nullif(p_plan->>'dueDate', '')::date;
  select coalesce(sum(impact_days), 0)::integer into adjustment_days
    from public.delay_adjustments
    where organization_id = p_org_id and order_id = p_order_id;
  forecast_end := case when planned_end is null then null else planned_end + adjustment_days end;

  update public.production_orders
  set forecast_end_date = production_orders.planned_end_date + adjustment_days
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';

  update public.orders
  set planned_start_date = planned_start,
      planned_end_date = planned_end,
      forecast_end_date = forecast_end,
      requested_due_date = requested_due,
      updated_at = now()
  where id = p_order_id and organization_id = p_org_id;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'orders', p_order_id, 'plan_committed', 'acesso-publico', p_plan);

  return jsonb_build_object(
    'orderId', p_order_id,
    'unitCount', allocation_count,
    'scheduleCount', schedule_count,
    'plannedStartDate', planned_start,
    'plannedEndDate', planned_end,
    'forecastEndDate', forecast_end
  );
end;
$$;

-- Regrava em uma única transação os pedidos ainda não iniciados, mantendo a
-- fila global ordenada pelo motor e evitando colisões com posições antigas.
create or replace function public.commit_planning_queue(
  p_org_id uuid,
  p_plans jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_row jsonb;
  order_row_id uuid;
  plan_result jsonb;
  results jsonb := '[]'::jsonb;
  plan_count integer;
  seen_order_ids uuid[] := '{}'::uuid[];
begin
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' then
    raise exception 'Fila inválida: plans precisa ser uma lista.';
  end if;
  plan_count := jsonb_array_length(p_plans);
  if plan_count > 1000 then
    raise exception 'A fila não pode conter mais de 1000 pedidos.';
  end if;

  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    order_row_id := nullif(plan_row->>'orderId', '')::uuid;
    if order_row_id is null or jsonb_typeof(plan_row->'plan') is distinct from 'object' then
      raise exception 'A fila contém um pedido ou plano inválido.';
    end if;
    if order_row_id = any(seen_order_ids) then
      raise exception 'A fila contém o mesmo pedido mais de uma vez.';
    end if;
    seen_order_ids := array_append(seen_order_ids, order_row_id);
    if not exists (
      select 1 from public.orders o
      where o.id = order_row_id and o.organization_id = p_org_id and o.is_active = true
    ) then
      raise exception 'Pedido da fila não encontrado.';
    end if;
    if exists (
      select 1 from public.production_orders po
      where po.organization_id = p_org_id and po.order_id = order_row_id
        and po.status in ('in_progress','done','scrapped')
    ) or exists (
      select 1 from public.production_schedules ps
      where ps.organization_id = p_org_id and ps.order_id = order_row_id
        and ps.status in ('in_progress','done')
    ) or exists (
      select 1 from public.allocations a
      join public.production_orders po on po.id = a.production_order_id
      where po.organization_id = p_org_id and po.order_id = order_row_id
        and a.status in ('in_progress','done')
    ) then
      raise exception 'Pedido com produção iniciada ou concluída não pode ser replanejado.';
    end if;
  end loop;

  delete from public.allocations a
  using public.production_orders po
  where a.production_order_id = po.id
    and po.organization_id = p_org_id
    and po.status = 'planned'
    and po.order_id in (select (value->>'orderId')::uuid from jsonb_array_elements(p_plans));
  delete from public.production_orders
  where organization_id = p_org_id and status = 'planned'
    and order_id in (select (value->>'orderId')::uuid from jsonb_array_elements(p_plans));
  delete from public.production_schedules
  where organization_id = p_org_id and status = 'planned'
    and order_id in (select (value->>'orderId')::uuid from jsonb_array_elements(p_plans));

  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    order_row_id := (plan_row->>'orderId')::uuid;
    select public.commit_order_plan(p_org_id, order_row_id, plan_row->'plan') into plan_result;
    results := results || jsonb_build_array(plan_result);
  end loop;

  return jsonb_build_object('orderCount', plan_count, 'orders', results);
end;
$$;

create or replace function public.save_delay_adjustment(
  p_org_id uuid,
  p_order_id uuid,
  p_reason text,
  p_occurred_on date,
  p_adjusted_forecast_end date,
  p_recorded_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_end date;
  impact integer;
  adjustment_id uuid;
  total_adjustment integer;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'Informe o motivo do ajuste.'; end if;
  select coalesce(forecast_end_date, planned_end_date) into previous_end
  from public.orders
  where id = p_order_id and organization_id = p_org_id and is_active = true
  for update;
  if previous_end is null then raise exception 'O pedido precisa ter uma data prevista antes do ajuste.'; end if;
  if p_adjusted_forecast_end is null then raise exception 'Informe a nova data prevista.'; end if;
  impact := p_adjusted_forecast_end - previous_end;
  if impact = 0 then raise exception 'A nova data deve ser diferente da previsão atual.'; end if;

  insert into public.delay_adjustments (
    organization_id, order_id, reason, occurred_on, impact_days,
    previous_forecast_end, adjusted_forecast_end, recorded_by
  ) values (
    p_org_id, p_order_id, trim(p_reason), p_occurred_on, impact,
    previous_end, p_adjusted_forecast_end, nullif(trim(p_recorded_by), '')
  ) returning id into adjustment_id;

  select coalesce(sum(impact_days), 0)::integer into total_adjustment
  from public.delay_adjustments where organization_id = p_org_id and order_id = p_order_id;

  update public.orders
  set forecast_end_date = planned_end_date + total_adjustment, updated_at = now()
  where id = p_order_id and organization_id = p_org_id;
  update public.production_orders
  set forecast_end_date = planned_end_date + total_adjustment
  where organization_id = p_org_id and order_id = p_order_id and status <> 'cancelled';

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'orders', p_order_id, 'delay_adjusted', coalesce(nullif(trim(p_recorded_by), ''), 'acesso-publico'),
    jsonb_build_object('adjustmentId', adjustment_id, 'reason', trim(p_reason), 'occurredOn', p_occurred_on,
      'impactDays', impact, 'previousForecastEnd', previous_end, 'adjustedForecastEnd', p_adjusted_forecast_end));

  return jsonb_build_object(
    'id', adjustment_id,
    'orderId', p_order_id,
    'impactDays', impact,
    'previousForecastEnd', previous_end,
    'adjustedForecastEnd', p_adjusted_forecast_end
  );
end;
$$;

revoke all on function public.commit_order_plan(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_order_plan(uuid, uuid, jsonb) to service_role;
revoke all on function public.commit_planning_queue(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_planning_queue(uuid, jsonb) to service_role;
revoke all on function public.save_delay_adjustment(uuid, uuid, text, date, date, text) from public, anon, authenticated;
grant execute on function public.save_delay_adjustment(uuid, uuid, text, date, date, text) to service_role;

commit;
