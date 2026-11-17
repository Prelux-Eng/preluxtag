-- PRELUX / Fabio II · Etapa 2: parâmetros versionados da Engenharia.
-- Script local para revisão. Não foi aplicado ao Supabase ativo.
-- Reaproveita as tabelas e os registros existentes; não remove dados.

begin;

create table if not exists public.engineering_parameter_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  preparation_workdays smallint not null check (preparation_workdays > 0),
  casting_workdays smallint not null check (casting_workdays = 1),
  curing_calendar_days smallint not null check (curing_calendar_days > 0),
  finishing_workdays smallint not null check (finishing_workdays = 1),
  max_castings_per_workday smallint not null check (max_castings_per_workday > 0),
  maximum_order_calendar_days smallint not null check (maximum_order_calendar_days > 0),
  casting_start_time time without time zone not null,
  concrete_density_kg_m3 numeric(12,3) not null check (concrete_density_kg_m3 > 0),
  created_at timestamptz not null default now(),
  unique (organization_id, version_number),
  unique (organization_id, id)
);

alter table public.engineering_parameter_versions enable row level security;
revoke all on public.engineering_parameter_versions from public, anon, authenticated;
grant select on public.engineering_parameter_versions to service_role;

-- Um conjunto inicial por organização. Os valores vêm das regras já aprovadas
-- e da configuração atualmente registrada; os registros antigos não são apagados.
insert into public.engineering_parameter_versions (
  organization_id,
  version_number,
  preparation_workdays,
  casting_workdays,
  curing_calendar_days,
  finishing_workdays,
  max_castings_per_workday,
  maximum_order_calendar_days,
  casting_start_time,
  concrete_density_kg_m3
)
select
  o.id,
  1,
  5,
  1,
  2,
  1,
  4,
  90,
  time '08:00',
  2500.000
from public.organizations o
where o.is_active
  and not exists (
    select 1
    from public.engineering_parameter_versions existing
    where existing.organization_id = o.id
  );

-- Uma nova configuração altera prazos e capacidade do cenário. Ela precisa
-- invalidar simulações abertas antes de uma confirmação transacional.
drop trigger if exists trg_engineering_versions_touch_factory_plan_revision
  on public.engineering_parameter_versions;
create trigger trg_engineering_versions_touch_factory_plan_revision
after insert on public.engineering_parameter_versions
for each row execute function public.touch_factory_plan_revision();

-- Guarda qual versão técnica foi usada quando um pedido entra no fluxo aprovado.
alter table public.orders
  add column if not exists engineering_parameter_version_id uuid,
  add column if not exists version integer not null default 1;

alter table public.piece_types
  add column if not exists version integer not null default 1;

alter table public.production_orders
  add column if not exists version integer not null default 1;

alter table public.mold_positions
  add column if not exists version integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_version_positive_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_version_positive_check check (version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'piece_types_version_positive_check'
      and conrelid = 'public.piece_types'::regclass
  ) then
    alter table public.piece_types
      add constraint piece_types_version_positive_check check (version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'production_orders_version_positive_check'
      and conrelid = 'public.production_orders'::regclass
  ) then
    alter table public.production_orders
      add constraint production_orders_version_positive_check check (version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'mold_positions_version_positive_check'
      and conrelid = 'public.mold_positions'::regclass
  ) then
    alter table public.mold_positions
      add constraint mold_positions_version_positive_check check (version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_engineering_parameter_version_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_engineering_parameter_version_fkey
      foreign key (organization_id, engineering_parameter_version_id)
      references public.engineering_parameter_versions (organization_id, id)
      on delete restrict;
  end if;
end
$$;

-- Pedidos que já estejam aprovados guardam a versão corrente sem recriar o pedido.
update public.orders o
set engineering_parameter_version_id = (
  select epv.id
  from public.engineering_parameter_versions epv
  where epv.organization_id = o.organization_id
  order by epv.version_number desc
  limit 1
)
where o.status::text in ('aprovado', 'em_producao', 'atrasado', 'concluido', 'entregue')
  and o.engineering_parameter_version_id is null;

create or replace function public.capture_order_engineering_parameter_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parameter_version_id uuid;
begin
  if tg_op = 'UPDATE' then
    if old.approved_at is not null
      and new.engineering_parameter_version_id is distinct from old.engineering_parameter_version_id then
      raise exception 'A versão de Engenharia de um pedido aprovado não pode ser alterada.';
    end if;
  end if;

  if new.status::text in ('aprovado', 'em_producao', 'atrasado', 'concluido', 'entregue')
    and (
      new.engineering_parameter_version_id is null
      or tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and old.status::text = 'orcamento')
    ) then
    select epv.id
    into v_parameter_version_id
    from public.engineering_parameter_versions epv
    where epv.organization_id = new.organization_id
    order by epv.version_number desc
    limit 1;

    if v_parameter_version_id is null then
      raise exception 'Não há uma versão dos parâmetros de Engenharia para esta organização.';
    end if;

    new.engineering_parameter_version_id := v_parameter_version_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_capture_order_engineering_parameter_version on public.orders;
create trigger trg_capture_order_engineering_parameter_version
before insert or update of status, engineering_parameter_version_id
on public.orders
for each row execute function public.capture_order_engineering_parameter_version();

create or replace function public.reject_engineering_parameter_version_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Versões de parâmetros de Engenharia são imutáveis; crie uma nova versão.';
end;
$$;

drop trigger if exists trg_reject_engineering_parameter_version_update on public.engineering_parameter_versions;
create trigger trg_reject_engineering_parameter_version_update
before update or delete on public.engineering_parameter_versions
for each row execute function public.reject_engineering_parameter_version_mutation();

create or replace function public.bump_optimistic_record_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists trg_orders_bump_version on public.orders;
create trigger trg_orders_bump_version
before update on public.orders
for each row execute function public.bump_optimistic_record_version();

drop trigger if exists trg_piece_types_bump_version on public.piece_types;
create trigger trg_piece_types_bump_version
before update on public.piece_types
for each row execute function public.bump_optimistic_record_version();

drop trigger if exists trg_production_orders_bump_version on public.production_orders;
create trigger trg_production_orders_bump_version
before update on public.production_orders
for each row execute function public.bump_optimistic_record_version();

drop trigger if exists trg_mold_positions_bump_version on public.mold_positions;
create trigger trg_mold_positions_bump_version
before update on public.mold_positions
for each row execute function public.bump_optimistic_record_version();

create or replace function public.create_engineering_parameter_version(
  p_organization_id uuid,
  p_expected_version integer,
  p_parameters jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_version integer;
  v_new_version public.engineering_parameter_versions%rowtype;
  v_preparation_workdays smallint;
  v_casting_workdays smallint;
  v_curing_calendar_days smallint;
  v_finishing_workdays smallint;
  v_max_castings_per_workday smallint;
  v_maximum_order_calendar_days smallint;
  v_casting_start_time time without time zone;
  v_concrete_density numeric(12,3);
begin
  if p_organization_id is null or p_parameters is null or pg_catalog.jsonb_typeof(p_parameters) <> 'object' then
    raise exception 'Envie a organização e os novos parâmetros de Engenharia.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_organization_id::text),
    pg_catalog.hashtext('engineering_parameter_versions')
  );

  select coalesce(max(epv.version_number), 0)
  into v_current_version
  from public.engineering_parameter_versions epv
  where epv.organization_id = p_organization_id;

  if p_expected_version is distinct from v_current_version then
    raise exception using
      errcode = '40001',
      message = 'Os parâmetros mudaram desde a leitura. Recarregue a versão atual antes de salvar.';
  end if;

  if coalesce(p_parameters->>'preparationWorkdays', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'castingWorkdays', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'curingCalendarDays', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'finishingWorkdays', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'maxCastingsPerWorkday', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'maximumOrderCalendarDays', '') !~ '^[1-9][0-9]*$'
    or coalesce(p_parameters->>'castingStartTime', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_parameters->>'concreteDensityKgM3', '') !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'Um ou mais parâmetros de Engenharia estão ausentes ou inválidos.';
  end if;

  v_preparation_workdays := (p_parameters->>'preparationWorkdays')::smallint;
  v_casting_workdays := (p_parameters->>'castingWorkdays')::smallint;
  v_curing_calendar_days := (p_parameters->>'curingCalendarDays')::smallint;
  v_finishing_workdays := (p_parameters->>'finishingWorkdays')::smallint;
  v_max_castings_per_workday := (p_parameters->>'maxCastingsPerWorkday')::smallint;
  v_maximum_order_calendar_days := (p_parameters->>'maximumOrderCalendarDays')::smallint;
  v_casting_start_time := (p_parameters->>'castingStartTime')::time;
  v_concrete_density := (p_parameters->>'concreteDensityKgM3')::numeric(12,3);

  if v_casting_workdays <> 1 or v_finishing_workdays <> 1 then
    raise exception 'A concretagem e o acabamento precisam ocupar um dia útil cada, conforme o processo e as etapas de produção já existentes.';
  end if;

  if v_concrete_density <= 0 then
    raise exception 'A densidade do concreto deve ser maior que zero.';
  end if;

  insert into public.engineering_parameter_versions (
    organization_id,
    version_number,
    preparation_workdays,
    casting_workdays,
    curing_calendar_days,
    finishing_workdays,
    max_castings_per_workday,
    maximum_order_calendar_days,
    casting_start_time,
    concrete_density_kg_m3
  ) values (
    p_organization_id,
    v_current_version + 1,
    v_preparation_workdays,
    v_casting_workdays,
    v_curing_calendar_days,
    v_finishing_workdays,
    v_max_castings_per_workday,
    v_maximum_order_calendar_days,
    v_casting_start_time,
    v_concrete_density
  ) returning * into v_new_version;

  insert into public.audit_logs (
    organization_id, entity_name, entity_id, action, actor_label, payload
  ) values (
    p_organization_id,
    'engineering_parameter_versions',
    v_new_version.id,
    'create_version',
    'sistema-sem-login',
    pg_catalog.jsonb_build_object(
      'previousVersion', v_current_version,
      'newVersion', pg_catalog.to_jsonb(v_new_version)
    )
  );

  return pg_catalog.to_jsonb(v_new_version);
end;
$$;

revoke all on function public.create_engineering_parameter_version(uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_engineering_parameter_version(uuid, integer, jsonb)
  to service_role;

commit;
