-- Etapa 5 · Correções após revisão de integração.
-- Uma alocação conserva os códigos da forma usada mesmo que o catálogo mude.
alter table public.allocations
  add column if not exists mold_catalog_codes text[] not null default '{}'::text[];

-- Desmontagem explícita ou troca para bancada de placas encerra a reutilização
-- da última forma concluída. A configuração física antiga permanece auditável.
alter table public.mold_positions
  add column if not exists form_reset_at timestamptz;

create or replace function public.snapshot_allocation_form()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  select coalesce(pg_catalog.array_agg(ptm.catalog_code order by ptm.catalog_code)
    filter (where ptm.catalog_code is not null), '{}'::text[])
  into new.mold_catalog_codes
  from public.production_orders po
  join public.order_items oi
    on oi.organization_id = po.organization_id and oi.id = po.order_item_id
  left join public.piece_type_molds ptm
    on ptm.organization_id = oi.organization_id and ptm.piece_type_id = oi.piece_type_id
  where po.organization_id = new.organization_id and po.id = new.production_order_id;
  return new;
end;
$function$;

revoke all on function public.snapshot_allocation_form() from public, anon, authenticated;
drop trigger if exists trg_snapshot_allocation_form on public.allocations;
create trigger trg_snapshot_allocation_form
before insert or update of production_order_id on public.allocations
for each row execute function public.snapshot_allocation_form();

-- Fotografa as linhas legadas sem eliminar unidades nem reservas existentes.
update public.allocations a
set mold_catalog_codes = coalesce((
  select pg_catalog.array_agg(ptm.catalog_code order by ptm.catalog_code)
  from public.production_orders po
  join public.order_items oi
    on oi.organization_id = po.organization_id and oi.id = po.order_item_id
  join public.piece_type_molds ptm
    on ptm.organization_id = oi.organization_id and ptm.piece_type_id = oi.piece_type_id
  where po.organization_id = a.organization_id and po.id = a.production_order_id
), '{}'::text[])
where a.mold_catalog_codes = '{}'::text[];

create index if not exists allocations_position_form_history_idx
  on public.allocations (organization_id, mold_position_id, scheduled_date desc)
  where status <> 'cancelled';

create or replace function public.reset_form_when_position_kind_changes()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.configuration_kind is distinct from old.configuration_kind then
    new.form_reset_at := pg_catalog.now();
  end if;
  return new;
end;
$function$;

revoke all on function public.reset_form_when_position_kind_changes() from public, anon, authenticated;
drop trigger if exists trg_reset_form_when_position_kind_changes on public.mold_positions;
create trigger trg_reset_form_when_position_kind_changes
before update on public.mold_positions
for each row execute function public.reset_form_when_position_kind_changes();

-- A última concretagem concluída define a forma que continua montada.
-- A troca de tipo da posição ou a desmontagem manual interrompem o histórico.
create or replace function public.factory_installed_form_by_position(p_org_id uuid)
returns table (mold_position_id uuid, mold_catalog_codes text[])
language sql
stable
security invoker
set search_path = ''
as $function$
  select distinct on (a.mold_position_id)
    a.mold_position_id, a.mold_catalog_codes
  from public.allocations a
  join public.mold_positions mp
    on mp.organization_id = a.organization_id and mp.id = a.mold_position_id
  join public.production_orders po
    on po.organization_id = a.organization_id and po.id = a.production_order_id
  where a.organization_id = p_org_id
    and pg_catalog.cardinality(a.mold_catalog_codes) > 0
    and (
      a.status = 'done' or po.status = 'done'
      or exists (
        select 1 from public.production_order_steps s
        where s.organization_id = po.organization_id and s.production_order_id = po.id
          and s.step_kind = 'concretagem' and s.status = 'done'
      )
    )
    and (mp.form_reset_at is null
      or coalesce(a.occupied_until_at, a.scheduled_date::timestamptz) > mp.form_reset_at)
  order by a.mold_position_id,
    coalesce(a.occupied_until_at, a.scheduled_date::timestamptz) desc, a.id desc;
$function$;

revoke all on function public.factory_installed_form_by_position(uuid) from public, anon, authenticated;
grant execute on function public.factory_installed_form_by_position(uuid) to service_role;

create or replace function public.reset_factory_position_form(p_org_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_position_id uuid;
  v_reset_at timestamptz;
begin
  select mp.id into v_position_id
  from public.mold_positions mp
  where mp.organization_id = p_org_id and mp.code = p_code
    and mp.configuration_kind is distinct from 'placa'
  for update;
  if v_position_id is null then
    raise exception 'Posição de forma não encontrada.' using errcode = '23503';
  end if;
  if exists (
    select 1 from public.allocations a
    where a.organization_id = p_org_id and a.mold_position_id = v_position_id
      and a.status in ('planned', 'in_progress')
  ) then
    raise exception 'Reprograme ou conclua as unidades reservadas antes de desmontar a forma.' using errcode = '40001';
  end if;
  update public.mold_positions mp
  set form_reset_at = pg_catalog.now()
  where mp.id = v_position_id and mp.organization_id = p_org_id
  returning mp.form_reset_at into v_reset_at;
  return pg_catalog.jsonb_build_object('positionCode', p_code, 'formResetAt', v_reset_at);
end;
$function$;

revoke all on function public.reset_factory_position_form(uuid, text) from public, anon, authenticated;
grant execute on function public.reset_factory_position_form(uuid, text) to service_role;

-- Abaixo, a função de confirmação é redefinida para preservar datas de
-- pedidos encerrados durante a reconstrução da fila ativa.

create or replace function public.commit_factory_simulation(
  p_org_id uuid,
  p_expected_revision bigint,
  p_approve_order_ids uuid[],
  p_plans jsonb,
  p_calendar_days jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_current_revision bigint;
  v_plan jsonb;
  v_day jsonb;
  v_order_id uuid;
  v_commit jsonb;
  v_commit_results jsonb := '[]'::jsonb;
  v_requested integer := 0;
  v_scheduled integer := 0;
  v_approved integer := 0;
begin
  if p_plans is null or pg_catalog.jsonb_typeof(p_plans) <> 'array'
    or pg_catalog.jsonb_array_length(p_plans) > 30 then
    raise exception 'A confirmação aceita uma lista de até 30 pedidos.' using errcode = '22023';
  end if;
  if p_calendar_days is null or pg_catalog.jsonb_typeof(p_calendar_days) <> 'array'
    or pg_catalog.jsonb_array_length(p_calendar_days) > 20000 then
    raise exception 'O calendário enviado para confirmação é inválido.' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(coalesce(p_approve_order_ids, '{}'::uuid[])) > 30 then
    raise exception 'Selecione até 30 orçamentos para aprovação.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('prelux-factory-plan:' || p_org_id::text, 0)
  );
  select r.revision into v_current_revision
  from public.factory_plan_revisions r
  where r.organization_id = p_org_id
  for update;
  if v_current_revision is null then raise exception 'Unidade sem revisão de Planejamento.' using errcode = '23503'; end if;
  if v_current_revision <> p_expected_revision then
    raise exception 'Os dados mudaram depois da simulação; atualize o Planejamento.' using errcode = '40001';
  end if;

  if (select pg_catalog.count(distinct selected.id) from pg_catalog.unnest(coalesce(p_approve_order_ids, '{}'::uuid[])) selected(id))
    <> pg_catalog.cardinality(coalesce(p_approve_order_ids, '{}'::uuid[])) then
    raise exception 'A lista contém orçamentos repetidos.' using errcode = '22023';
  end if;
  foreach v_order_id in array coalesce(p_approve_order_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.orders o where o.id = v_order_id
        and o.organization_id = p_org_id and o.is_active and o.status = 'orcamento'
    ) then raise exception 'Um orçamento selecionado não está mais disponível.' using errcode = '40001'; end if;
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_plans) plan_row(value)
      where (plan_row.value->>'orderId')::uuid = v_order_id
    ) then raise exception 'O orçamento selecionado não faz parte do cenário recalculado.' using errcode = '22023'; end if;
  end loop;

  for v_plan in select value from pg_catalog.jsonb_array_elements(p_plans) loop
    v_order_id := nullif(v_plan->>'orderId', '')::uuid;
    if v_order_id is null or pg_catalog.jsonb_typeof(v_plan->'plan') is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_plan->'plan'->'units') is distinct from 'array' then
      raise exception 'Cada pedido precisa conter um plano com uma lista de unidades.' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.orders o
      where o.id = v_order_id and o.organization_id = p_org_id and o.is_active
        and o.status in ('orcamento', 'aprovado', 'em_producao', 'atrasado')
    ) then raise exception 'Um pedido da simulação está encerrado ou não existe.' using errcode = '23503'; end if;
    if exists (
      select 1 from public.orders o where o.id = v_order_id and o.status = 'orcamento'
        and not (v_order_id = any(coalesce(p_approve_order_ids, '{}'::uuid[])))
    ) then raise exception 'Orçamentos só podem ser confirmados quando selecionados explicitamente.' using errcode = '42501'; end if;
    if public.factory_order_has_started_production(p_org_id, v_order_id) then
      raise exception 'Pedido com produção iniciada não pode ser reprogramado.' using errcode = '40001';
    end if;
  end loop;

  update public.orders o set status = 'aprovado'::public.order_status
  where o.organization_id = p_org_id and o.id = any(coalesce(p_approve_order_ids, '{}'::uuid[]));
  get diagnostics v_approved = row_count;

  for v_day in select value from pg_catalog.jsonb_array_elements(p_calendar_days) loop
    if nullif(v_day->>'date', '') is null
      or coalesce((v_day->>'capacity_minutes')::integer, -1) < 0
      or coalesce(v_day->>'source', 'regra') not in ('regra', 'excecao', 'manual') then
      raise exception 'O calendário contém um dia inválido.' using errcode = '22023';
    end if;
    insert into public.calendar_days (
      organization_id, date, is_working, capacity_minutes, source, exception_id, note, generated_at
    ) values (
      p_org_id, (v_day->>'date')::date, coalesce((v_day->>'is_working')::boolean, false),
      (v_day->>'capacity_minutes')::integer, coalesce(v_day->>'source', 'regra'),
      nullif(v_day->>'exception_id', '')::uuid, nullif(v_day->>'note', ''), pg_catalog.now()
    ) on conflict (organization_id, date) do update set
      is_working = excluded.is_working,
      capacity_minutes = excluded.capacity_minutes,
      source = excluded.source,
      exception_id = excluded.exception_id,
      note = excluded.note,
      generated_at = excluded.generated_at;
  end loop;

  -- Libera somente unidades ainda planejadas de pedidos sem início. Ordens,
  -- etapas e alocações iniciadas/concluídas permanecem intactas.
  delete from public.allocations a using public.production_orders po
  where a.production_order_id = po.id and a.organization_id = p_org_id
    and po.organization_id = p_org_id and a.status = 'planned' and po.status = 'planned'
    and not public.factory_order_has_started_production(p_org_id, po.order_id);
  delete from public.production_orders po
  where po.organization_id = p_org_id and po.status = 'planned'
    and not public.factory_order_has_started_production(p_org_id, po.order_id);
  delete from public.production_schedules ps
  where ps.organization_id = p_org_id and ps.status = 'planned'
    and not public.factory_order_has_started_production(p_org_id, ps.order_id);
  update public.orders o set planned_start_date = null, planned_end_date = null, forecast_end_date = null
  where o.organization_id = p_org_id
    and o.is_active and o.status in ('orcamento', 'aprovado', 'atrasado')
    and not public.factory_order_has_started_production(p_org_id, o.id);

  select public.commit_planning_queue(p_org_id, p_plans) into v_commit_results;

  for v_plan in select value from pg_catalog.jsonb_array_elements(p_plans) loop
    v_order_id := (v_plan->>'orderId')::uuid;
    update public.orders o set
      planned_start_date = nullif(v_plan->'plan'->>'effectiveStartDate', '')::date,
      planned_end_date = nullif(v_plan->'plan'->>'plannedEndDate', '')::date,
      forecast_end_date = nullif(v_plan->'plan'->>'forecastEndDate', '')::date
    where o.organization_id = p_org_id and o.id = v_order_id;
    v_scheduled := v_scheduled + pg_catalog.jsonb_array_length(v_plan->'plan'->'units');
  end loop;

  select coalesce(sum(oi.quantity), 0)::integer into v_requested
  from public.order_items oi
  where oi.organization_id = p_org_id
    and oi.order_id in (
      select (value->>'orderId')::uuid from pg_catalog.jsonb_array_elements(p_plans)
    );

  select r.revision into v_current_revision
  from public.factory_plan_revisions r where r.organization_id = p_org_id;
  return pg_catalog.jsonb_build_object(
    'approvedOrderCount', v_approved,
    'orderCount', pg_catalog.jsonb_array_length(p_plans),
    'scheduledUnitCount', v_scheduled,
    'requestedUnitCount', v_requested,
    'waitingUnitCount', greatest(v_requested - v_scheduled, 0),
    'revision', v_current_revision,
    'orders', v_commit_results
  );
end;
$function$;

revoke all on function public.commit_factory_simulation(uuid, bigint, uuid[], jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_factory_simulation(uuid, bigint, uuid[], jsonb, jsonb)
  to service_role;
