begin;

-- A carga usada no plano é o tempo ativo de concretagem da unidade. Cura e
-- acabamento mantêm suas etapas próprias; a preparação continua reservando
-- a posição por dias úteis, sem consumir estes minutos de concretagem.

alter table public.withdrawn_unit_form_events
  add column if not exists production_minutes_snapshot integer;

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'withdrawn_unit_form_events_production_minutes_check'
      and conrelid = 'public.withdrawn_unit_form_events'::regclass
  ) then
    alter table public.withdrawn_unit_form_events
      add constraint withdrawn_unit_form_events_production_minutes_check
      check (production_minutes_snapshot is null or production_minutes_snapshot >= 0);
  end if;
end;
$migration$;

-- Recupera das auditorias a carga de concretagem das unidades retiradas.
-- Eventos sem retrato antigo ficam nulos e o simulador reserva o turno cheio.
update public.withdrawn_unit_form_events e
set production_minutes_snapshot = coalesce(
  nullif(a.payload #>> '{before,unit,production_minutes_snapshot}', '')::integer,
  nullif(a.payload #>> '{before,units,0,production_minutes_snapshot}', '')::integer,
  nullif(a.payload #>> '{before,orderItem,production_minutes_snapshot}', '')::integer
)
from public.audit_logs a
where e.organization_id = a.organization_id
  and a.entity_name = 'production_orders'
  and a.entity_id = e.source_unit_id
  and a.action = 'withdraw'
  and e.production_minutes_snapshot is null;

create or replace function public.fill_withdrawn_unit_form_event()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_allocation public.allocations;
  v_production_minutes integer;
begin
  select * into v_allocation
  from public.allocations a
  where a.organization_id = new.organization_id
    and a.id = new.source_allocation_id;
  if not found or v_allocation.production_order_id <> new.source_unit_id then
    raise exception 'A alocação da forma retirada não está disponível.' using errcode = '23503';
  end if;

  select coalesce(
    nullif(po.production_minutes_snapshot, 0),
    nullif(oi.production_minutes_snapshot, 0),
    nullif(pt.production_minutes_per_unit, 0)
  )
  into v_production_minutes
  from public.production_orders po
  left join public.order_items oi
    on oi.organization_id = po.organization_id and oi.id = po.order_item_id
  left join public.piece_types pt
    on pt.organization_id = oi.organization_id and pt.id = oi.piece_type_id
  where po.organization_id = new.organization_id and po.id = new.source_unit_id;

  new.scheduled_date := v_allocation.scheduled_date;
  new.occupied_from_at := v_allocation.occupied_from_at;
  new.production_minutes_snapshot := v_production_minutes;
  new.casting_completed := v_allocation.status = 'done' or exists (
    select 1 from public.production_order_steps s
    where s.organization_id = new.organization_id
      and s.production_order_id = new.source_unit_id
      and s.step_kind = 'concretagem' and s.status = 'done'
  );
  return new;
end;
$function$;

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
  v_production_minutes integer;
  v_capacity integer;
  v_legacy_duration integer;
  v_prep_first date;
  v_prep_last date;
  v_prep_count integer;
  v_cast_end timestamptz;
  v_daily_step boolean := false;
  v_legacy_full_shift boolean := false;
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
  select po.planned_cast_date, po.curing_days, po.production_minutes_snapshot
  into v_cast_date, v_curing_days, v_production_minutes
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
      and v_production_minutes > 0
      and new.duration_minutes = v_production_minutes
      and new.duration_minutes <= v_capacity
      and (new.planned_start_at at time zone v_timezone)::time = v_shift_start
      and v_step_date = v_cast_date;
    v_legacy_full_shift := v_capacity is not null
      and new.duration_minutes = v_capacity
      and (new.planned_start_at at time zone v_timezone)::time = v_shift_start
      and v_step_date = v_cast_date;
    if not v_daily_step and not v_legacy_full_shift then
      select cc.numeric_value::integer into v_legacy_duration
      from public.calculation_constants cc
      where cc.organization_id = new.organization_id
        and cc.constant_key = 'casting_duration_minutes' and cc.unit = 'min';
      if v_legacy_duration is null or new.duration_minutes <> v_legacy_duration then
        raise exception 'A concretagem deve usar os minutos do tipo de peça dentro da capacidade do turno.';
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

create or replace function public.validate_calendar_day_production_capacity()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_scheduled_minutes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'prelux-production-capacity:' || new.organization_id::text || ':' || new.date::text, 0
  ));

  select coalesce(sum(ps.planned_minutes), 0)::bigint
  into v_scheduled_minutes
  from public.production_schedules ps
  where ps.organization_id = new.organization_id
    and ps.work_date = new.date
    and ps.status::text in ('planned', 'in_progress', 'done');

  if v_scheduled_minutes > 0 and (
    not new.is_working or new.capacity_minutes < v_scheduled_minutes
  ) then
    raise exception 'O calendário não pode reduzir a capacidade abaixo dos % minutos já programados para %.',
      v_scheduled_minutes, new.date using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_validate_calendar_day_production_capacity on public.calendar_days;
create trigger trg_validate_calendar_day_production_capacity
before insert or update of is_working, capacity_minutes
on public.calendar_days
for each row execute function public.validate_calendar_day_production_capacity();

create or replace function public.validate_production_schedule_capacity()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_capacity integer;
  v_is_working boolean;
  v_other_minutes bigint;
begin
  if new.status::text not in ('planned', 'in_progress', 'done') then
    return new;
  end if;
  if new.planned_minutes < 1 then
    raise exception 'A carga de concretagem programada precisa ser maior que zero.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'prelux-production-capacity:' || new.organization_id::text || ':' || new.work_date::text, 0
  ));
  select cd.capacity_minutes, cd.is_working
  into v_capacity, v_is_working
  from public.calendar_days cd
  where cd.organization_id = new.organization_id and cd.date = new.work_date;
  if v_capacity is null or not v_is_working or v_capacity < 1 then
    raise exception 'A programação precisa apontar para um dia útil com capacidade no calendário.' using errcode = '23514';
  end if;

  select coalesce(sum(ps.planned_minutes), 0)::bigint
  into v_other_minutes
  from public.production_schedules ps
  where ps.organization_id = new.organization_id
    and ps.work_date = new.work_date
    and ps.status::text in ('planned', 'in_progress', 'done')
    and ps.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_other_minutes + new.planned_minutes > v_capacity then
    raise exception 'A concretagem excede a capacidade diária: % minutos planejados para % minutos disponíveis.',
      v_other_minutes + new.planned_minutes, v_capacity using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_validate_production_schedule_capacity on public.production_schedules;
create trigger trg_validate_production_schedule_capacity
before insert or update of organization_id, work_date, planned_minutes, status
on public.production_schedules
for each row execute function public.validate_production_schedule_capacity();

create index if not exists production_schedules_daily_capacity_idx
  on public.production_schedules (organization_id, work_date)
  where status in ('planned', 'in_progress', 'done');

revoke all on function public.validate_production_schedule_capacity()
  from public, anon, authenticated;
revoke all on function public.validate_calendar_day_production_capacity()
  from public, anon, authenticated;
revoke all on function public.fill_withdrawn_unit_form_event()
  from public, anon, authenticated;
revoke all on function public.validate_production_order_step()
  from public, anon, authenticated;

commit;
