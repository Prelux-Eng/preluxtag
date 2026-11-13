-- Etapa 5: revisão otimista do cenário e confirmação atômica da fila diária.
-- A aplicação continua sem login: somente Edge Functions com service_role
-- podem ler a revisão e chamar a RPC de confirmação.

create table if not exists public.factory_plan_revisions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  last_transaction_id xid8,
  updated_at timestamptz not null default now()
);

alter table public.factory_plan_revisions enable row level security;
revoke all on table public.factory_plan_revisions from public, anon, authenticated;
grant select on table public.factory_plan_revisions to service_role;

insert into public.factory_plan_revisions (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

create or replace function public.bump_factory_plan_revision(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_transaction_id xid8 := pg_catalog.pg_current_xact_id();
begin
  if p_organization_id is null or not exists (
    select 1 from public.organizations o where o.id = p_organization_id
  ) then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('prelux-factory-plan:' || p_organization_id::text, 0)
  );

  insert into public.factory_plan_revisions (
    organization_id, revision, last_transaction_id, updated_at
  ) values (p_organization_id, 1, v_transaction_id, pg_catalog.now())
  on conflict (organization_id) do update
    set revision = public.factory_plan_revisions.revision + 1,
        last_transaction_id = excluded.last_transaction_id,
        updated_at = excluded.updated_at
    where public.factory_plan_revisions.last_transaction_id
      is distinct from excluded.last_transaction_id;
end;
$function$;

create or replace function public.touch_factory_plan_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old jsonb;
  v_new jsonb;
  v_org_id uuid;
begin
  if tg_table_name = 'mold_catalog' then
    for v_org_id in select o.id from public.organizations o loop
      perform public.bump_factory_plan_revision(v_org_id);
    end loop;
  else
    if tg_op <> 'INSERT' then v_old := pg_catalog.to_jsonb(old); end if;
    if tg_op <> 'DELETE' then v_new := pg_catalog.to_jsonb(new); end if;

    if tg_table_name = 'organizations' then
      v_org_id := coalesce((v_new->>'id')::uuid, (v_old->>'id')::uuid);
    else
      v_org_id := coalesce((v_new->>'organization_id')::uuid, (v_old->>'organization_id')::uuid);
    end if;
    perform public.bump_factory_plan_revision(v_org_id);

    if tg_op = 'UPDATE' and tg_table_name <> 'organizations'
      and (v_old->>'organization_id') is distinct from (v_new->>'organization_id') then
      perform public.bump_factory_plan_revision((v_old->>'organization_id')::uuid);
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke all on function public.bump_factory_plan_revision(uuid) from public, anon, authenticated;
revoke all on function public.touch_factory_plan_revision() from public, anon, authenticated;

do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'organizations', 'works', 'orders', 'order_items', 'piece_types',
    'piece_type_molds', 'mold_positions', 'mold_catalog', 'calendar_settings',
    'calendar_working_rules', 'calendar_exceptions', 'calendar_days',
    'delay_adjustments', 'calculation_constants', 'production_orders',
    'production_order_steps', 'allocations', 'production_schedules'
  ] loop
    execute pg_catalog.format(
      'drop trigger if exists trg_touch_factory_plan_revision on public.%I', v_table
    );
    execute pg_catalog.format(
      'create trigger trg_touch_factory_plan_revision after insert or update or delete on public.%I for each row execute function public.touch_factory_plan_revision()',
      v_table
    );
  end loop;
end;
$block$;

-- Preparação passa a ser uma etapa planejável. As etapas legadas permanecem.
alter table public.production_order_steps
  drop constraint if exists production_order_steps_step_kind_check;
alter table public.production_order_steps
  add constraint production_order_steps_step_kind_check
  check (step_kind = any (array[
    'preparacao'::text, 'concretagem'::text, 'cura'::text,
    'acabamento'::text, 'inspecao'::text, 'liberacao'::text
  ]));

-- Valida janelas novas da Etapa 5 e ainda aceita as durações históricas de 120
-- minutos de concretagem e 12 horas de cura já gravadas no banco.
create or replace function public.validate_production_order_step()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_timezone text;
  v_shift_constant numeric;
  v_shift_start time;
  v_step_date date;
  v_cast_date date;
  v_curing_days integer;
  v_capacity integer;
  v_legacy_duration integer;
  v_prep_first date;
  v_prep_last date;
  v_prep_count integer;
  v_cast_end timestamptz;
  v_daily_step boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext(new.production_order_id::text)::bigint);

  select o.timezone into v_timezone
  from public.organizations o where o.id = new.organization_id;
  select coalesce(cc.numeric_value, 8) into v_shift_constant
  from public.calculation_constants cc
  where cc.organization_id = new.organization_id
    and cc.constant_key = 'casting_start_hour' and cc.unit = 'h';
  v_shift_constant := coalesce(v_shift_constant, 8);
  v_shift_start := make_time(
    floor(v_shift_constant)::integer,
    round((v_shift_constant - floor(v_shift_constant)) * 60)::integer,
    0
  );
  select po.planned_cast_date, po.curing_days
  into v_cast_date, v_curing_days
  from public.production_orders po
  where po.organization_id = new.organization_id and po.id = new.production_order_id;

  if new.step_kind = 'preparacao' and new.status <> 'cancelled' then
    if new.duration_minutes is not null or new.planned_start_at is null or new.planned_end_at is null then
      raise exception 'A preparação precisa de horários exatos e não recebe duração em minutos.';
    end if;
    v_step_date := (new.planned_start_at at time zone v_timezone)::date;
    select min(days.date), max(days.date), count(*)::integer
    into v_prep_first, v_prep_last, v_prep_count
    from (
      select cd.date
      from public.calendar_days cd
      where cd.organization_id = new.organization_id
        and cd.date < v_cast_date
        and cd.is_working = true and cd.capacity_minutes > 0
      order by cd.date desc
      limit 5
    ) days;
    if v_prep_count <> 5 or v_step_date <> v_prep_first
      or (new.planned_end_at at time zone v_timezone)::date <> v_prep_last then
      raise exception 'A preparação precisa cobrir os cinco dias úteis imediatamente anteriores à concretagem.';
    end if;
    select cd.capacity_minutes into v_capacity
    from public.calendar_days cd
    where cd.organization_id = new.organization_id and cd.date = v_prep_first
      and cd.is_working and cd.capacity_minutes > 0;
    if (new.planned_start_at at time zone v_timezone)::time <> v_shift_start
      or new.planned_start_at <> timezone(v_timezone, v_prep_first + v_shift_start) then
      raise exception 'A preparação deve começar no início do turno do primeiro dia útil.';
    end if;
    select cd.capacity_minutes into v_capacity
    from public.calendar_days cd
    where cd.organization_id = new.organization_id and cd.date = v_prep_last
      and cd.is_working and cd.capacity_minutes > 0;
    if new.planned_end_at <> timezone(v_timezone, v_prep_last + v_shift_start)
      + make_interval(mins => v_capacity) then
      raise exception 'A preparação deve terminar no fim do turno do quinto dia útil.';
    end if;
  end if;

  if new.step_kind = 'concretagem' and new.status <> 'cancelled' then
    if new.duration_minutes is null or new.planned_start_at is null or new.planned_end_at is null then
      raise exception 'A concretagem precisa de duração e horários planejados exatos.';
    end if;
    v_step_date := (new.planned_start_at at time zone v_timezone)::date;
    select cd.capacity_minutes into v_capacity
    from public.calendar_days cd
    where cd.organization_id = new.organization_id and cd.date = v_step_date
      and cd.is_working = true and cd.capacity_minutes > 0;
    v_daily_step := v_capacity is not null
      and new.duration_minutes = v_capacity
      and (new.planned_start_at at time zone v_timezone)::time = v_shift_start
      and v_step_date = v_cast_date;
    if not v_daily_step then
      select cc.numeric_value::integer into v_legacy_duration
      from public.calculation_constants cc
      where cc.organization_id = new.organization_id
        and cc.constant_key = 'casting_duration_minutes' and cc.unit = 'min';
      if v_legacy_duration is null or new.duration_minutes <> v_legacy_duration then
        raise exception 'A concretagem deve usar a capacidade do turno ou respeitar o registro histórico da etapa.';
      end if;
    end if;
  end if;

  if new.step_kind = 'cura' and new.status <> 'cancelled' then
    if new.duration_minutes is null or new.planned_start_at is null or new.planned_end_at is null then
      raise exception 'A cura precisa de duração e horários planejados exatos.';
    end if;
    v_daily_step := new.duration_minutes = v_curing_days * 1440;
    if not v_daily_step then
      select (cc.numeric_value * 60)::integer into v_legacy_duration
      from public.calculation_constants cc
      where cc.organization_id = new.organization_id
        and cc.constant_key = 'curing_duration_hours' and cc.unit = 'h';
      if v_legacy_duration is null or new.duration_minutes <> v_legacy_duration then
        raise exception 'A cura deve respeitar os dias corridos do tipo de peça ou a duração histórica.';
      end if;
    else
      select cast_step.planned_end_at into v_cast_end
      from public.production_order_steps cast_step
      where cast_step.organization_id = new.organization_id
        and cast_step.production_order_id = new.production_order_id
        and cast_step.step_kind = 'concretagem';
      if v_cast_end is null or new.planned_start_at <> v_cast_end then
        raise exception 'A cura deve começar assim que a concretagem terminar.';
      end if;
    end if;
  end if;

  if new.step_kind = 'acabamento' and new.planned_start_at is not null
    and new.status <> 'cancelled' then
    if new.duration_minutes is null then
      raise exception 'O acabamento planejado precisa registrar a capacidade do turno.';
    end if;
    v_step_date := (new.planned_start_at at time zone v_timezone)::date;
    select cd.capacity_minutes into v_capacity
    from public.calendar_days cd
    where cd.organization_id = new.organization_id and cd.date = v_step_date
      and cd.is_working = true and cd.capacity_minutes > 0;
    if v_capacity is null or new.duration_minutes <> v_capacity
      or (new.planned_start_at at time zone v_timezone)::time <> v_shift_start then
      raise exception 'O acabamento precisa ocupar um turno útil do calendário.';
    end if;
  end if;

  if new.duration_minutes is not null and new.planned_start_at is not null and new.planned_end_at is not null
    and extract(epoch from (new.planned_end_at - new.planned_start_at)) / 60 <> new.duration_minutes then
    raise exception 'Os horários planejados precisam corresponder à duração informada em minutos.';
  end if;
  if new.planned_start_at is not null and exists (
    select 1 from public.production_order_steps other_step
    where other_step.organization_id = new.organization_id
      and other_step.production_order_id = new.production_order_id
      and other_step.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and other_step.planned_start_at is not null and other_step.planned_end_at is not null
      and new.planned_start_at < other_step.planned_end_at
      and new.planned_end_at > other_step.planned_start_at
  ) then
    raise exception 'As etapas planejadas da mesma peça não podem se sobrepor.';
  end if;
  return new;
end;
$function$;

-- Mantém as validações de compatibilidade e protege a reserva pela janela nova.
create or replace function public.validate_allocation_compatibility_and_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_kind text;
  v_piece_type_id uuid;
  v_position_configuration text;
  v_position_status text;
  v_timezone text;
  v_catalog_code text;
  v_start timestamptz;
  v_end timestamptz;
  v_cast_start timestamptz;
  v_cast_end timestamptz;
  v_cure_end timestamptz;
  v_prepare_start timestamptz;
  v_daily_model boolean := false;
begin
  if new.status not in ('planned', 'in_progress') then return new; end if;

  if tg_op = 'UPDATE'
    and old.occupied_from_at is null and old.occupied_until_at is null
    and new.occupied_from_at is null and new.occupied_until_at is null
    and new.mold_position_id = old.mold_position_id
    and new.scheduled_date = old.scheduled_date
    and new.production_order_id = old.production_order_id
    and new.organization_id = old.organization_id
    and not exists (
      select 1 from public.production_order_steps s
      where s.organization_id = old.organization_id and s.production_order_id = old.production_order_id
    ) then
    return new;
  end if;

  if new.occupied_from_at is null or new.occupied_until_at is null then
    raise exception 'Uma alocação ativa precisa registrar os horários exatos de ocupação da posição.';
  end if;

  select pt.piece_kind, pt.id, mp.configuration_kind, mp.status
  into v_kind, v_piece_type_id, v_position_configuration, v_position_status
  from public.production_orders po
  join public.order_items oi on oi.id = po.order_item_id and oi.organization_id = po.organization_id
  join public.piece_types pt on pt.id = oi.piece_type_id and pt.organization_id = oi.organization_id
  join public.mold_positions mp on mp.id = new.mold_position_id and mp.organization_id = new.organization_id
  where po.id = new.production_order_id and po.organization_id = new.organization_id;
  if not found then raise exception 'Produção ou posição não pertence à unidade informada.'; end if;
  if v_position_status = 'em_manutencao' then raise exception 'A posição está em manutenção.'; end if;

  perform pg_advisory_xact_lock(hashtext(v_piece_type_id::text)::bigint);
  for v_catalog_code in
    select ptm.catalog_code from public.piece_type_molds ptm
    where ptm.organization_id = new.organization_id and ptm.piece_type_id = v_piece_type_id
    order by ptm.catalog_code
  loop
    perform pg_advisory_xact_lock(hashtext('mold_catalog:' || v_catalog_code)::bigint);
  end loop;

  if v_kind = 'braco' then
    if v_position_configuration = 'placa' then
      raise exception 'A posição está reservada como bancada plana para placas.';
    end if;
    if not exists (
      select 1 from public.piece_type_molds ptm
      join public.mold_catalog mc on mc.code = ptm.catalog_code
      where ptm.organization_id = new.organization_id and ptm.piece_type_id = v_piece_type_id
        and ptm.role = 'braco' and mc.mold_type = 'BRACO'
    ) then raise exception 'O item do pedido precisa ter uma forma BRAÇO compatível antes da alocação.'; end if;
  elsif v_kind in ('pilar', 'viga') then
    if v_position_configuration = 'placa' then
      raise exception 'A posição está reservada como bancada plana para placas.';
    end if;
    if not exists (
      select 1 from public.piece_type_molds bed
      join public.mold_catalog bed_catalog on bed_catalog.code = bed.catalog_code and bed_catalog.mold_type = 'LEITO'
      join public.piece_type_molds side on side.organization_id = bed.organization_id
        and side.piece_type_id = bed.piece_type_id and side.role = 'lateral'
      join public.mold_catalog side_catalog on side_catalog.code = side.catalog_code and side_catalog.mold_type = 'LATERAL'
      where bed.organization_id = new.organization_id and bed.piece_type_id = v_piece_type_id and bed.role = 'leito'
    ) then raise exception 'O item do pedido precisa ter LEITO e LATERAL compatíveis antes da alocação.'; end if;
  elsif v_kind = 'placa' then
    if v_position_configuration is distinct from 'placa' or exists (
      select 1 from public.piece_type_molds ptm
      where ptm.organization_id = new.organization_id and ptm.piece_type_id = v_piece_type_id
    ) then raise exception 'A placa precisa de uma bancada plana e não pode ter formas vinculadas.'; end if;
  else
    raise exception 'Classifique o tipo da peça antes de programar sua produção.';
  end if;

  select cast_step.planned_start_at, cast_step.planned_end_at, cure_step.planned_end_at,
    prep_step.planned_start_at,
    (cure_step.duration_minutes = po.curing_days * 1440)
  into v_cast_start, v_cast_end, v_cure_end, v_prepare_start, v_daily_model
  from public.production_orders po
  join public.production_order_steps cast_step
    on cast_step.organization_id = po.organization_id and cast_step.production_order_id = po.id
    and cast_step.step_kind = 'concretagem'
  join public.production_order_steps cure_step
    on cure_step.organization_id = po.organization_id and cure_step.production_order_id = po.id
    and cure_step.step_kind = 'cura'
  left join public.production_order_steps prep_step
    on prep_step.organization_id = po.organization_id and prep_step.production_order_id = po.id
    and prep_step.step_kind = 'preparacao'
  where po.organization_id = new.organization_id and po.id = new.production_order_id;
  if v_cast_start is null or v_cast_end is null or v_cure_end is null then
    raise exception 'Planeje concretagem e cura antes de alocar a posição.';
  end if;

  if coalesce(v_daily_model, false) then
    if new.occupied_from_at is distinct from coalesce(v_prepare_start, v_cast_start)
      or new.occupied_until_at is distinct from v_cast_end then
      raise exception 'A posição deve ficar reservada da preparação até o fim da concretagem; a cura ocorre fora dela.';
    end if;
  elsif new.occupied_from_at > v_cast_start or new.occupied_until_at < v_cure_end then
    raise exception 'A alocação histórica deve cobrir concretagem e cura.';
  end if;

  select o.timezone into v_timezone from public.organizations o where o.id = new.organization_id;
  v_start := new.occupied_from_at;
  v_end := new.occupied_until_at;
  if v_end <= v_start then raise exception 'O intervalo de ocupação da posição é inválido.'; end if;

  perform pg_advisory_xact_lock(hashtext(new.mold_position_id::text)::bigint);
  if exists (
    select 1 from public.allocations a
    where a.organization_id = new.organization_id and a.mold_position_id = new.mold_position_id
      and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and a.status in ('planned', 'in_progress')
      and (a.scheduled_date = new.scheduled_date
        or (v_start < coalesce(a.occupied_until_at, timezone(v_timezone, (a.scheduled_date + 1)::timestamp))
          and v_end > coalesce(a.occupied_from_at, timezone(v_timezone, a.scheduled_date::timestamp))))
  ) then raise exception 'A posição já está ocupada durante o intervalo solicitado.'; end if;
  return new;
end;
$function$;

-- RPC de confirmação. O navegador nunca fornece horários confiáveis: a Edge
-- Function volta a calcular o cenário e esta função valida sua revisão dentro
-- da mesma transação que aprova orçamentos e grava as reservas.
create or replace function public.factory_order_has_started_production(
  p_org_id uuid,
  p_order_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $function$
  select
    exists (
      select 1 from public.production_orders po
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and po.status in ('in_progress', 'done', 'scrapped')
    )
    or exists (
      select 1 from public.production_order_steps s
      join public.production_orders po
        on po.organization_id = s.organization_id and po.id = s.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and s.status in ('in_progress', 'done')
    )
    or exists (
      select 1 from public.allocations a
      join public.production_orders po
        on po.organization_id = a.organization_id and po.id = a.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and a.status in ('in_progress', 'done')
    )
    or exists (
      select 1 from public.production_schedules ps
      where ps.organization_id = p_org_id and ps.order_id = p_order_id
        and ps.status in ('in_progress', 'done')
    );
$function$;

revoke all on function public.factory_order_has_started_production(uuid, uuid)
  from public, anon, authenticated;

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
    and o.status <> 'concluido'::public.order_status
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
