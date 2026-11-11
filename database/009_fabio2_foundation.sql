-- PRELUX / Fábio II · fundação incremental da etapa 5
-- Reaproveita as tabelas existentes. Integracao aprovada para este rascunho local;
-- a migration ainda nao foi aplicada ao projeto Supabase ativo.

begin;

-- ---------------------------------------------------------------------------
-- Status: o enum legado continua existindo, mas `concluido` deixa de ser aceito
-- em novos registros/alterações. NOT VALID preserva linhas históricas existentes.
-- ---------------------------------------------------------------------------
alter table public.orders
  drop constraint if exists orders_status_not_concluido_check;
alter table public.orders
  add constraint orders_status_not_concluido_check
  check (status <> 'concluido'::public.order_status) not valid;

-- Placa passa a ser um tipo de peça. Os cálculos antigos de peça não são tocados.
alter table public.piece_types
  drop constraint if exists piece_types_piece_kind_check;
alter table public.piece_types
  add constraint piece_types_piece_kind_check
  check (piece_kind is null or piece_kind in ('braco', 'pilar', 'viga', 'placa'))
  not valid;
alter table public.piece_types
  validate constraint piece_types_piece_kind_check;

-- Os códigos de catálogo são chaves estáveis. O usuário pode editar os rótulos
-- das medidas e a ordem de exibição sem quebrar vínculos históricos.
alter table public.mold_catalog
  drop constraint if exists mold_catalog_check;
alter table public.mold_catalog
  drop constraint if exists mold_catalog_measure_label_nonblank_check;
alter table public.mold_catalog
  add constraint mold_catalog_measure_label_nonblank_check
  check (length(trim(measure_label)) > 0);

-- Uma posição `placa` representa uma bancada plana: não referencia uma forma.
alter table public.mold_positions
  drop constraint if exists mold_positions_configuration_kind_check;
alter table public.mold_positions
  add constraint mold_positions_configuration_kind_check
  check (configuration_kind is null or configuration_kind in ('braco', 'pilar_viga', 'placa'));

alter table public.mold_positions
  drop constraint if exists mold_positions_configuration_shape_check;
alter table public.mold_positions
  add constraint mold_positions_configuration_shape_check
  check (
    (configuration_kind is null and braco_catalog_code is null and leito_catalog_code is null and lateral_catalog_code is null)
    or (configuration_kind = 'braco' and braco_catalog_code is not null and leito_catalog_code is null and lateral_catalog_code is null)
    or (configuration_kind = 'pilar_viga' and braco_catalog_code is null and leito_catalog_code is not null and lateral_catalog_code is not null)
    or (configuration_kind = 'placa' and braco_catalog_code is null and leito_catalog_code is null and lateral_catalog_code is null)
  );

-- Guardar o rótulo usado em novas linhas do histórico evita que uma edição
-- futura no catálogo reescreva visualmente a configuração registrada.
alter table public.mold_position_configuration_history
  add column if not exists braco_measure_snapshot text,
  add column if not exists leito_measure_snapshot text,
  add column if not exists lateral_measure_snapshot text;

update public.mold_position_configuration_history h
set braco_measure_snapshot = coalesce(h.braco_measure_snapshot,
      (select c.measure_label from public.mold_catalog c where c.code = h.braco_catalog_code)),
    leito_measure_snapshot = coalesce(h.leito_measure_snapshot,
      (select c.measure_label from public.mold_catalog c where c.code = h.leito_catalog_code)),
    lateral_measure_snapshot = coalesce(h.lateral_measure_snapshot,
      (select c.measure_label from public.mold_catalog c where c.code = h.lateral_catalog_code));

-- ---------------------------------------------------------------------------
-- Preparação de formas: cinco dias úteis, contados pelo calendário existente.
-- ---------------------------------------------------------------------------
alter table public.molds
  drop constraint if exists molds_preparation_days_check;
alter table public.molds alter column preparation_days set default 5;
update public.molds set preparation_days = 5 where preparation_days <> 5;
alter table public.molds
  add constraint molds_preparation_days_check check (preparation_days = 5);

alter table public.mold_preparations
  drop constraint if exists mold_preparations_check;

create or replace function public.validate_mold_preparation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_required_workdays integer;
  v_completion_day date;
begin
  select m.preparation_days::integer into v_required_workdays
  from public.molds m
  where m.id = new.mold_id and m.organization_id = new.organization_id and m.status <> 'retirado';
  if not found then
    raise exception 'Forma não encontrada ou retirada nesta unidade.';
  end if;

  select cd.date into v_completion_day
  from public.calendar_days cd
  where cd.organization_id = new.organization_id
    and cd.is_working = true
    and cd.date >= new.start_date
  order by cd.date
  offset (v_required_workdays - 1) limit 1;

  if v_completion_day is null then
    raise exception 'Gere o calendário de dias úteis antes de programar a preparação da forma.';
  end if;
  if new.end_date <> v_completion_day then
    raise exception 'A preparação da forma deve abranger cinco dias úteis do calendário.';
  end if;

  if new.status = 'aprovada' then
    if new.end_date > current_date then
      raise exception 'A preparação só pode ser aprovada depois dos cinco dias úteis.';
    end if;
    if coalesce((new.checklist->>'limpeza')::boolean, false) is not true
      or coalesce((new.checklist->>'desmoldante')::boolean, false) is not true
      or coalesce((new.checklist->>'montagem')::boolean, false) is not true then
      raise exception 'Conclua limpeza, desmoldante e montagem antes de aprovar a forma.';
    end if;
    if nullif(trim(new.approved_by), '') is null then
      raise exception 'Informe quem aprovou a preparação da forma.';
    end if;
    new.approved_at := coalesce(new.approved_at, now());
  else
    new.approved_at := null;
  end if;

  if new.status <> 'cancelada' then
    perform pg_advisory_xact_lock(hashtext(new.organization_id::text || ':mold:' || new.mold_id::text)::bigint);
    if exists (
      select 1 from public.mold_preparations p
      where p.organization_id = new.organization_id
        and p.mold_id = new.mold_id
        and p.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
        and p.status <> 'cancelada'
        and p.start_date <= new.end_date and p.end_date >= new.start_date
    ) then
      raise exception 'A forma já tem outra preparação neste período.';
    end if;
    if exists (
      select 1 from public.resource_allocations a
      where a.organization_id = new.organization_id
        and a.resource_kind = 'mold'
        and a.mold_id = new.mold_id
        and a.status <> 'cancelled'
        and a.start_date <= new.end_date and a.end_date >= new.start_date
    ) then
      raise exception 'A forma está alocada à produção durante este período.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_mold_preparation on public.mold_preparations;
create trigger trg_validate_mold_preparation
before insert or update on public.mold_preparations
for each row execute function public.validate_mold_preparation();

-- ---------------------------------------------------------------------------
-- Medidas e timestamps exatos das etapas. Os campos de data já existentes
-- continuam como resumos para compatibilidade com telas e relatórios atuais.
-- ---------------------------------------------------------------------------
alter table public.production_orders
  drop constraint if exists production_orders_check,
  drop constraint if exists production_orders_check1,
  drop constraint if exists production_orders_check2,
  drop constraint if exists production_orders_check3;
alter table public.production_orders
  add constraint production_orders_stage_date_order_check
  check (
    planned_cure_start_date >= planned_cast_date
    and planned_cure_end_date >= planned_cure_start_date
    and planned_finish_date >= planned_cure_end_date
    and planned_end_date = planned_finish_date
  );

alter table public.allocations
  add column if not exists occupied_from_at timestamptz,
  add column if not exists occupied_until_at timestamptz;
alter table public.allocations
  drop constraint if exists allocations_occupied_window_check;
alter table public.allocations
  add constraint allocations_occupied_window_check
  check (
    (occupied_from_at is null and occupied_until_at is null)
    or (occupied_from_at is not null and occupied_until_at is not null and occupied_until_at > occupied_from_at)
  );

create unique index if not exists production_orders_org_id_id_uidx
  on public.production_orders (organization_id, id);
create unique index if not exists orders_org_id_id_uidx
  on public.orders (organization_id, id);
create unique index if not exists order_items_org_id_id_uidx
  on public.order_items (organization_id, id);

-- Garante a sequencia PED global da organizacao sem afetar numeros legados.
do $$
begin
  if exists (
    select 1
    from public.orders
    where order_number ~* '^PED-[0-9]+$'
    group by organization_id, upper(order_number)
    having count(*) > 1
  ) then
    raise exception 'Existem numeros PED duplicados. Corrija-os antes de criar o indice unico.';
  end if;
end;
$$;
create unique index if not exists orders_org_ped_number_uidx
  on public.orders (organization_id, upper(order_number))
  where order_number ~* '^PED-[0-9]+$';

create table if not exists public.production_order_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  production_order_id uuid not null,
  step_kind text not null check (step_kind in ('concretagem', 'cura', 'acabamento', 'inspecao', 'liberacao')),
  sequence smallint not null check (sequence > 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  actual_start_at timestamptz,
  actual_end_at timestamptz,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'done', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, production_order_id, step_kind),
  unique (organization_id, production_order_id, sequence),
  foreign key (organization_id, production_order_id)
    references public.production_orders (organization_id, id) on delete cascade,
  check ((planned_start_at is null) = (planned_end_at is null)),
  check (planned_end_at is null or planned_end_at > planned_start_at),
  check ((actual_start_at is null) = (actual_end_at is null)),
  check (actual_end_at is null or actual_end_at >= actual_start_at)
);
create index if not exists production_order_steps_timeline_idx
  on public.production_order_steps (organization_id, planned_start_at, planned_end_at);
drop trigger if exists trg_production_order_steps_updated_at on public.production_order_steps;
create trigger trg_production_order_steps_updated_at
before update on public.production_order_steps
for each row execute function public.set_updated_at();

create or replace function public.validate_production_order_step()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expected_duration integer;
  v_constant_value numeric;
begin
  perform pg_advisory_xact_lock(hashtext(new.production_order_id::text)::bigint);
  if new.step_kind in ('concretagem', 'cura') and new.status <> 'cancelled' then
    if new.duration_minutes is null or new.planned_start_at is null or new.planned_end_at is null then
      raise exception 'Concretagem e cura precisam de duração e horários planejados exatos.';
    end if;
    if new.step_kind = 'concretagem' then
      select cc.numeric_value into v_constant_value
      from public.calculation_constants cc
      where cc.organization_id = new.organization_id and cc.constant_key = 'casting_duration_minutes' and cc.unit = 'min';
      v_expected_duration := v_constant_value::integer;
    else
      select cc.numeric_value into v_constant_value
      from public.calculation_constants cc
      where cc.organization_id = new.organization_id and cc.constant_key = 'curing_duration_hours' and cc.unit = 'h';
      v_expected_duration := (v_constant_value * 60)::integer;
    end if;
    if v_expected_duration is null or new.duration_minutes <> v_expected_duration then
      raise exception 'A duração da etapa diverge da constante cadastrada para esta unidade.';
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
$$;
drop trigger if exists trg_validate_production_order_step on public.production_order_steps;
create trigger trg_validate_production_order_step
before insert or update on public.production_order_steps
for each row execute function public.validate_production_order_step();

create or replace function public.require_core_production_steps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('planned', 'in_progress') and (
    not exists (select 1 from public.production_order_steps s
      where s.organization_id = new.organization_id and s.production_order_id = new.id and s.step_kind = 'concretagem')
    or not exists (select 1 from public.production_order_steps s
      where s.organization_id = new.organization_id and s.production_order_id = new.id and s.step_kind = 'cura')
  ) then
    raise exception 'A ordem de produção precisa registrar concretagem e cura com horários exatos.';
  end if;
  return null;
end;
$$;
drop trigger if exists trg_require_core_production_steps on public.production_orders;
create constraint trigger trg_require_core_production_steps
after insert or update on public.production_orders
deferrable initially deferred
for each row execute function public.require_core_production_steps();

-- Valores globais do catálogo de formas são editáveis, mas a chave e o tipo
-- permanecem estáveis porque são usados por vínculos existentes.
create or replace function public.guard_mold_catalog_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('mold_catalog:' || old.code)::bigint);
  if new.code is distinct from old.code or new.mold_type is distinct from old.mold_type then
    raise exception 'O código e o tipo da forma são identificadores estáveis; edite apenas a medida ou a ordem.';
  end if;
  if new.measure_label is distinct from old.measure_label and exists (
    select 1
    from public.mold_positions mp
    join public.allocations a on a.mold_position_id = mp.id and a.organization_id = mp.organization_id
    join public.production_orders po on po.id = a.production_order_id and po.organization_id = a.organization_id
    where a.status in ('planned', 'in_progress')
      and po.status in ('planned', 'in_progress')
      and old.code = any(array_remove(array[mp.braco_catalog_code, mp.leito_catalog_code, mp.lateral_catalog_code], null))
  ) then
    raise exception 'A medida de uma forma não pode mudar enquanto uma produção planejada ou em andamento a utiliza.';
  end if;
  if new.measure_label is distinct from old.measure_label and exists (
    select 1
    from public.piece_type_molds ptm
    join public.order_items oi on oi.piece_type_id = ptm.piece_type_id and oi.organization_id = ptm.organization_id
    join public.orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
    where ptm.catalog_code = old.code
      and o.status not in ('entregue'::public.order_status, 'cancelado'::public.order_status, 'concluido'::public.order_status)
  ) then
    raise exception 'A medida de uma forma não pode mudar enquanto estiver vinculada a um pedido não encerrado.';
  end if;
  if new.measure_label is distinct from old.measure_label and exists (
    select 1
    from public.molds m
    join public.resource_allocations ra on ra.mold_id = m.id and ra.organization_id = m.organization_id
    where m.catalog_code = old.code and ra.status in ('planned', 'in_progress')
  ) then
    raise exception 'A medida de uma forma não pode mudar enquanto houver alocação operacional ativa.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_mold_catalog_update on public.mold_catalog;
create trigger trg_guard_mold_catalog_update
before update on public.mold_catalog
for each row execute function public.guard_mold_catalog_update();

create or replace function public.audit_mold_catalog_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.measure_label is distinct from old.measure_label or new.sort_order is distinct from old.sort_order then
    insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
    select o.id, 'mold_catalog', null, 'updated', 'acesso-publico',
      jsonb_build_object('code', new.code, 'oldMeasure', old.measure_label, 'newMeasure', new.measure_label,
        'oldSortOrder', old.sort_order, 'newSortOrder', new.sort_order)
    from public.organizations o;
    if new.measure_label is distinct from old.measure_label then
      update public.molds
      set name = initcap(new.mold_type) || ' ' || new.measure_label,
          dimensions = new.measure_label || ' cm'
      where catalog_code = new.code;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_audit_mold_catalog_update on public.mold_catalog;
create trigger trg_audit_mold_catalog_update
after update on public.mold_catalog
for each row execute function public.audit_mold_catalog_update();

-- ---------------------------------------------------------------------------
-- Cálculos: constantes por organização e projeto de engenharia por pedido.
-- ---------------------------------------------------------------------------
create table if not exists public.calculation_constants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  constant_key text not null,
  numeric_value numeric(18, 6) not null,
  unit text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, constant_key),
  check (length(trim(constant_key)) > 0),
  check (length(trim(unit)) > 0),
  check (numeric_value >= 0)
);
alter table public.calculation_constants
  drop constraint if exists calculation_constants_casting_start_hour_check;
alter table public.calculation_constants
  add constraint calculation_constants_casting_start_hour_check
  check (constant_key <> 'casting_start_hour'
    or (numeric_value = trunc(numeric_value) and numeric_value between 0 and 23));
insert into public.calculation_constants (organization_id, constant_key, numeric_value, unit)
select o.id, seed.constant_key, seed.numeric_value, seed.unit
from public.organizations o
cross join (values
  ('concrete_density_t_m3', 2.5::numeric, 't/m³'::text),
  ('casting_start_hour', 8::numeric, 'h'::text),
  ('casting_duration_minutes', 120::numeric, 'min'::text),
  ('curing_duration_hours', 12::numeric, 'h'::text)
) as seed(constant_key, numeric_value, unit)
on conflict (organization_id, constant_key) do nothing;

create or replace function public.audit_calculation_constant_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_id uuid;
  v_payload jsonb;
begin
  if tg_op = 'DELETE' then
    v_org_id := old.organization_id;
    v_id := old.id;
    v_payload := jsonb_build_object('constantKey', old.constant_key, 'oldValue', old.numeric_value, 'unit', old.unit);
  elsif tg_op = 'INSERT' then
    v_org_id := new.organization_id;
    v_id := new.id;
    v_payload := jsonb_build_object('constantKey', new.constant_key, 'newValue', new.numeric_value, 'unit', new.unit);
  else
    v_org_id := new.organization_id;
    v_id := new.id;
    v_payload := jsonb_build_object('constantKey', new.constant_key, 'oldValue', old.numeric_value,
      'newValue', new.numeric_value, 'unit', new.unit);
  end if;
  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (v_org_id, 'calculation_constants', v_id, lower(tg_op), 'acesso-publico', v_payload);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_calculation_constants_updated_at on public.calculation_constants;
create trigger trg_calculation_constants_updated_at
before update on public.calculation_constants
for each row execute function public.set_updated_at();
drop trigger if exists trg_audit_calculation_constant_change on public.calculation_constants;
create trigger trg_audit_calculation_constant_change
after insert or update or delete on public.calculation_constants
for each row execute function public.audit_calculation_constant_change();

create table if not exists public.engineering_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, order_id),
  unique (organization_id, id),
  foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);

create table if not exists public.project_sections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null,
  section_name text not null,
  sort_order smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, section_name),
  unique (organization_id, id),
  foreign key (organization_id, project_id)
    references public.engineering_projects (organization_id, id) on delete cascade,
  check (length(trim(section_name)) > 0),
  check (sort_order > 0)
);

create table if not exists public.project_section_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  section_id uuid not null,
  order_item_id uuid not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, section_id, order_item_id),
  foreign key (organization_id, section_id)
    references public.project_sections (organization_id, id) on delete cascade,
  foreign key (organization_id, order_item_id)
    references public.order_items (organization_id, id) on delete cascade
);
create index if not exists project_section_items_order_item_idx
  on public.project_section_items (organization_id, order_item_id);

create or replace function public.guard_engineering_project_order_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.order_id is distinct from old.order_id and exists (
    select 1 from public.project_sections ps
    join public.project_section_items psi on psi.section_id = ps.id and psi.organization_id = ps.organization_id
    join public.order_items oi on oi.id = psi.order_item_id and oi.organization_id = psi.organization_id
    where ps.organization_id = old.organization_id and ps.project_id = old.id and oi.order_id <> new.order_id
  ) then
    raise exception 'O pedido do projeto não pode mudar enquanto suas seções contiverem itens de outro pedido.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_engineering_project_order_change on public.engineering_projects;
create trigger trg_guard_engineering_project_order_change
before update of order_id on public.engineering_projects
for each row execute function public.guard_engineering_project_order_change();

create or replace function public.guard_project_section_parent_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.project_id is distinct from old.project_id and exists (
    select 1 from public.project_section_items psi
    join public.order_items oi on oi.id = psi.order_item_id and oi.organization_id = psi.organization_id
    join public.engineering_projects ep on ep.id = new.project_id and ep.organization_id = new.organization_id
    where psi.organization_id = old.organization_id and psi.section_id = old.id
      and oi.order_id <> ep.order_id
  ) then
    raise exception 'A seção não pode mudar de projeto enquanto seus itens pertencerem a outro pedido.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_project_section_parent_change on public.project_sections;
create trigger trg_guard_project_section_parent_change
before update of project_id on public.project_sections
for each row execute function public.guard_project_section_parent_change();

drop trigger if exists trg_engineering_projects_updated_at on public.engineering_projects;
create trigger trg_engineering_projects_updated_at
before update on public.engineering_projects
for each row execute function public.set_updated_at();
drop trigger if exists trg_project_sections_updated_at on public.project_sections;
create trigger trg_project_sections_updated_at
before update on public.project_sections
for each row execute function public.set_updated_at();
drop trigger if exists trg_project_section_items_updated_at on public.project_section_items;
create trigger trg_project_section_items_updated_at
before update on public.project_section_items
for each row execute function public.set_updated_at();

create or replace function public.validate_project_section_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_project_order_id uuid;
  v_requested_quantity integer;
  v_allocated_quantity integer;
begin
  select ep.order_id into v_project_order_id
  from public.project_sections ps
  join public.engineering_projects ep
    on ep.organization_id = ps.organization_id and ep.id = ps.project_id
  where ps.organization_id = new.organization_id and ps.id = new.section_id;
  if v_project_order_id is null then
    raise exception 'A seção do projeto não foi encontrada nesta unidade.';
  end if;

  select oi.quantity into v_requested_quantity
  from public.order_items oi
  where oi.organization_id = new.organization_id and oi.id = new.order_item_id
    and oi.order_id = v_project_order_id
  for update;
  if not found then
    raise exception 'O item precisa pertencer ao pedido vinculado ao projeto.';
  end if;

  select coalesce(sum(psi.quantity), 0)::integer into v_allocated_quantity
  from public.project_section_items psi
  where psi.organization_id = new.organization_id
    and psi.order_item_id = new.order_item_id
    and psi.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);
  if v_allocated_quantity + new.quantity > v_requested_quantity then
    raise exception 'A soma das quantidades nas seções não pode ultrapassar a quantidade do item pedido.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_project_section_item on public.project_section_items;
create trigger trg_validate_project_section_item
before insert or update on public.project_section_items
for each row execute function public.validate_project_section_item();

create or replace function public.assert_project_item_coverage(p_org_id uuid, p_order_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.engineering_projects ep
    where ep.organization_id = p_org_id and ep.order_id = p_order_id
  ) then
    return;
  end if;
  if not exists (
    select 1 from public.order_items oi
    where oi.organization_id = p_org_id and oi.order_id = p_order_id
  ) then
    raise exception 'O projeto precisa distribuir ao menos um item do pedido.';
  end if;
  if exists (
    select 1
    from public.order_items oi
    left join (
      select psi.order_item_id, sum(psi.quantity)::integer as allocated_quantity
      from public.project_section_items psi
      join public.project_sections ps
        on ps.organization_id = psi.organization_id and ps.id = psi.section_id
      join public.engineering_projects ep
        on ep.organization_id = ps.organization_id and ep.id = ps.project_id
      where psi.organization_id = p_org_id and ep.order_id = p_order_id
      group by psi.order_item_id
    ) allocated on allocated.order_item_id = oi.id
    where oi.organization_id = p_org_id and oi.order_id = p_order_id
      and coalesce(allocated.allocated_quantity, 0) <> oi.quantity
  ) then
    raise exception 'Distribua toda a quantidade de cada item do pedido entre as seções do projeto.';
  end if;
end;
$$;

-- Mantém a soma exata mesmo quando linhas são alteradas fora das RPCs de tela.
create or replace function public.enforce_project_item_coverage_after_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_order_id uuid;
begin
  if tg_table_name = 'engineering_projects' then
    if tg_op <> 'DELETE' then
      perform public.assert_project_item_coverage(new.organization_id, new.order_id);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    v_org_id := old.organization_id;
    v_order_id := old.order_id;
  else
    v_org_id := new.organization_id;
    v_order_id := new.order_id;
  end if;
  perform public.assert_project_item_coverage(v_org_id, v_order_id);
  if tg_op = 'UPDATE' and old.order_id is distinct from new.order_id then
    perform public.assert_project_item_coverage(old.organization_id, old.order_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_project_item_coverage_project on public.engineering_projects;
create constraint trigger trg_project_item_coverage_project
after insert or update or delete on public.engineering_projects
deferrable initially deferred
for each row execute function public.enforce_project_item_coverage_after_change();
drop trigger if exists trg_project_item_coverage_order_item on public.order_items;
create constraint trigger trg_project_item_coverage_order_item
after insert or update or delete on public.order_items
deferrable initially deferred
for each row execute function public.enforce_project_item_coverage_after_change();
-- Salva o projeto de engenharia e sua divisão em seções numa única transação.
-- Cada pedido mantém no máximo um projeto; as seções recebem somente itens
-- desse pedido e devem cobrir toda a quantidade de cada item do pedido.
create or replace function public.save_engineering_project_structure(
  p_org_id uuid,
  p_order_id uuid,
  p_sections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.engineering_projects;
  v_section public.project_sections;
  section_row jsonb;
  item_row jsonb;
  section_count integer := 0;
  item_count integer := 0;
  section_name_value text;
  sort_order_value smallint;
  item_id uuid;
  item_quantity integer;
begin
  if p_sections is null or jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception 'As seções do projeto precisam ser enviadas como uma lista.';
  end if;
  if jsonb_array_length(p_sections) = 0 or jsonb_array_length(p_sections) > 100 then
    raise exception 'Informe entre uma e cem seções para o projeto.';
  end if;
  if not exists (
    select 1 from public.orders o
    where o.organization_id = p_org_id and o.id = p_order_id and o.is_active = true
  ) then
    raise exception 'Pedido não encontrado ou inativo.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_sections) section
    group by lower(trim(section->>'sectionName'))
    having count(*) > 1
  ) then
    raise exception 'O nome de cada seção precisa ser único dentro do projeto.';
  end if;

  insert into public.engineering_projects (organization_id, order_id)
  values (p_org_id, p_order_id)
  on conflict (organization_id, order_id) do update set updated_at = now()
  returning * into v_project;

  for section_row in select value from jsonb_array_elements(p_sections) loop
    section_name_value := nullif(trim(section_row->>'sectionName'), '');
    sort_order_value := coalesce(nullif(section_row->>'sortOrder', '')::smallint, section_count + 1);
    if section_name_value is null or length(section_name_value) > 120 or sort_order_value < 1 then
      raise exception 'Cada seção precisa de um nome de até 120 caracteres e ordem positiva.';
    end if;
    if jsonb_typeof(section_row->'items') is distinct from 'array' then
      raise exception 'Os itens de cada seção precisam ser enviados como uma lista.';
    end if;
    if jsonb_array_length(section_row->'items') < 1 or jsonb_array_length(section_row->'items') > 500 then
      raise exception 'Cada seção precisa ter de um a quinhentos itens.';
    end if;

    insert into public.project_sections (organization_id, project_id, section_name, sort_order)
    values (p_org_id, v_project.id, section_name_value, sort_order_value)
    on conflict (organization_id, project_id, section_name)
    do update set sort_order = excluded.sort_order
    returning * into v_section;
    section_count := section_count + 1;
  end loop;

  -- O payload representa toda a divisão atual; limpar e recriar em uma
  -- transação permite mover itens entre seções sem ultrapassar limites no meio.
  delete from public.project_section_items psi
  using public.project_sections ps
  where ps.organization_id = psi.organization_id
    and ps.id = psi.section_id
    and ps.project_id = v_project.id;

  for section_row in select value from jsonb_array_elements(p_sections) loop
    select * into v_section from public.project_sections ps
    where ps.organization_id = p_org_id and ps.project_id = v_project.id
      and ps.section_name = trim(section_row->>'sectionName');
    for item_row in select value from jsonb_array_elements(section_row->'items') loop
      item_id := nullif(item_row->>'orderItemId', '')::uuid;
      item_quantity := nullif(item_row->>'quantity', '')::integer;
      if item_id is null or item_quantity is null or item_quantity < 1 then
        raise exception 'Cada item da seção precisa de pedido e quantidade positiva.';
      end if;
      insert into public.project_section_items (organization_id, section_id, order_item_id, quantity)
      values (p_org_id, v_section.id, item_id, item_quantity);
      item_count := item_count + 1;
    end loop;
  end loop;

  delete from public.project_sections ps
  where ps.organization_id = p_org_id and ps.project_id = v_project.id
    and not exists (
      select 1 from jsonb_array_elements(p_sections) desired
      where trim(desired->>'sectionName') = ps.section_name
    );

  -- A validação final permite movimentar itens entre seções nesta transação.
  perform public.assert_project_item_coverage(p_org_id, p_order_id);

  return jsonb_build_object(
    'projectId', v_project.id,
    'orderId', v_project.order_id,
    'sectionCount', section_count,
    'itemCount', item_count
  );
end;
$$;

-- Atualiza pedido, itens e distribuição por seções no mesmo commit.
-- `itemKey` permite relacionar o formulário às novas IDs de order_items,
-- que são recriadas pelo fluxo legado de salvamento do pedido.
create or replace function public.save_order_with_project(
  p_org_id uuid,
  p_order jsonb,
  p_items jsonb,
  p_sections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p_order->>'id', '')::uuid;
  v_work_id uuid := nullif(p_order->>'workId', '')::uuid;
  v_client_id uuid := nullif(p_order->>'clientId', '')::uuid;
  v_work_client_id uuid;
  v_work_start_date date;
  v_start_date date := coalesce(nullif(p_order->>'startDate', '')::date, current_date);
  v_due_date date := nullif(p_order->>'requestedDueDate', '')::date;
  v_status public.order_status := coalesce(nullif(p_order->>'status', ''), 'orcamento')::public.order_status;
  v_project_id uuid;
  v_order public.orders;
  v_item jsonb;
  v_section jsonb;
  v_section_item jsonb;
  v_item_key text;
  v_section_name text;
  v_item_key_to_id jsonb := '{}'::jsonb;
  v_resolved_sections jsonb := '[]'::jsonb;
  v_resolved_section_items jsonb;
  v_order_item_id uuid;
  v_piece_type_id uuid;
  v_quantity integer;
  v_minutes integer;
  v_sequence integer := 0;
  v_section_sequence integer := 0;
begin
  if v_id is null then
    raise exception 'O salvamento conjunto exige um pedido existente.';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Os itens do pedido precisam ser enviados como uma lista.';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'O pedido precisa ter entre um e cem itens.';
  end if;
  if p_sections is null or jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception 'As seções do projeto precisam ser enviadas como uma lista.';
  end if;
  if jsonb_array_length(p_sections) < 1 or jsonb_array_length(p_sections) > 100 then
    raise exception 'Informe de uma a cem seções para o projeto.';
  end if;
  select ep.id into v_project_id
  from public.engineering_projects ep
  where ep.organization_id = p_org_id and ep.order_id = v_id
  for update;
  if not found then
    raise exception 'O pedido não possui projeto de engenharia para salvar junto.';
  end if;
  select * into v_order
  from public.orders o
  where o.organization_id = p_org_id and o.id = v_id and o.is_active = true
  for update;
  if not found then
    raise exception 'Pedido não encontrado ou inativo.';
  end if;
  if v_due_date is not null and v_due_date < v_start_date then
    raise exception 'O prazo solicitado não pode ser anterior ao início.';
  end if;
  if v_work_id is not null then
    select w.client_id, w.start_date
      into v_work_client_id, v_work_start_date
    from public.works w
    where w.id = v_work_id and w.organization_id = p_org_id and w.is_active = true;
    if not found or v_work_client_id is null then
      raise exception 'Obra não encontrada, inativa ou sem cliente.';
    end if;
    if v_work_start_date is null then
      raise exception 'Cadastre a data de início da obra antes de vincular o pedido.';
    end if;
    v_client_id := v_work_client_id;
    v_start_date := v_work_start_date;
  elsif v_client_id is null or not exists (
    select 1 from public.clients c
    where c.id = v_client_id and c.organization_id = p_org_id and c.is_active = true
  ) then
    raise exception 'Selecione um cliente ativo.';
  end if;
  if v_due_date is not null and v_due_date < v_start_date then
    raise exception 'O prazo solicitado não pode ser anterior ao início.';
  end if;
  if exists (
    select 1 from public.production_schedules ps
    where ps.organization_id = p_org_id and ps.order_id = v_id
      and ps.status in ('in_progress', 'done')
  ) then
    raise exception 'Pedido com produção iniciada ou concluída não pode ser alterado neste cadastro.';
  end if;
  if exists (
    select 1 from public.production_orders po
    where po.organization_id = p_org_id and po.order_id = v_id
      and po.status in ('in_progress', 'done', 'scrapped')
  ) then
    raise exception 'Pedido com unidade de produção iniciada, concluída ou descartada não pode ser alterado neste cadastro.';
  end if;
  if exists (
    select 1 from public.resource_allocations ra
    join public.order_items oi on oi.id = ra.order_item_id and oi.organization_id = ra.organization_id
    where ra.organization_id = p_org_id and oi.order_id = v_id
  ) then
    raise exception 'O pedido já tem alocações de recursos registradas; mantenha os itens para preservar o histórico.';
  end if;

  update public.orders set
    order_number = nullif(trim(p_order->>'orderNumber'), ''),
    work_id = v_work_id,
    client_id = v_client_id,
    start_date = v_start_date,
    requested_due_date = v_due_date,
    planned_end_date = null,
    status = v_status,
    observations = nullif(trim(p_order->>'observations'), '')
  where organization_id = p_org_id and id = v_id
  returning * into v_order;
  if not found then
    raise exception 'Pedido não encontrado.';
  end if;

  delete from public.production_schedules
  where organization_id = p_org_id and order_id = v_id and status = 'planned';
  update public.stock_reservations
  set status = 'released', updated_at = now()
  where organization_id = p_org_id and order_id = v_id and status = 'reserved';
  delete from public.order_items
  where organization_id = p_org_id and order_id = v_id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_sequence := v_sequence + 1;
    v_item_key := nullif(trim(v_item->>'itemKey'), '');
    v_piece_type_id := nullif(v_item->>'pieceTypeId', '')::uuid;
    v_quantity := nullif(v_item->>'quantity', '')::integer;
    if v_item_key is null or length(v_item_key) > 80 or (v_item_key_to_id ? v_item_key) then
      raise exception 'Cada item precisa de uma chave temporária única.';
    end if;
    if v_piece_type_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'Cada item precisa de um tipo de peça e uma quantidade válida.';
    end if;
    select pt.production_minutes_per_unit into v_minutes
    from public.piece_types pt
    where pt.id = v_piece_type_id and pt.organization_id = p_org_id and pt.is_active = true;
    if not found or v_minutes is null then
      raise exception 'Tipo de peça não encontrado ou inativo.';
    end if;
    insert into public.order_items (
      organization_id, order_id, piece_type_id, quantity,
      production_minutes_snapshot, sequence, observations
    ) values (
      p_org_id, v_id, v_piece_type_id, v_quantity, v_minutes, v_sequence,
      nullif(trim(v_item->>'observations'), '')
    ) returning id into v_order_item_id;
    v_item_key_to_id := v_item_key_to_id || jsonb_build_object(v_item_key, v_order_item_id::text);
  end loop;

  for v_section in select value from jsonb_array_elements(p_sections) loop
    v_section_sequence := v_section_sequence + 1;
    v_section_name := nullif(trim(v_section->>'sectionName'), '');
    if v_section_name is null or length(v_section_name) > 120 then
      raise exception 'Cada seção precisa de um nome de até 120 caracteres.';
    end if;
    if jsonb_typeof(v_section->'items') is distinct from 'array' then
      raise exception 'Os itens de cada seção precisam ser enviados como uma lista.';
    end if;
    if jsonb_array_length(v_section->'items') < 1 or jsonb_array_length(v_section->'items') > 500 then
      raise exception 'Cada seção precisa de pelo menos um item e pode conter até quinhentos.';
    end if;

    v_resolved_section_items := '[]'::jsonb;
    for v_section_item in select value from jsonb_array_elements(v_section->'items') loop
      v_item_key := nullif(trim(v_section_item->>'itemKey'), '');
      v_order_item_id := nullif(v_item_key_to_id->>v_item_key, '')::uuid;
      v_quantity := nullif(v_section_item->>'quantity', '')::integer;
      if v_order_item_id is null then
        raise exception 'Uma seção referencia um item que não está no pedido editado.';
      end if;
      if v_quantity is null or v_quantity < 1 then
        raise exception 'Cada item da seção precisa ter uma quantidade positiva.';
      end if;
      v_resolved_section_items := v_resolved_section_items || jsonb_build_array(
        jsonb_build_object('orderItemId', v_order_item_id, 'quantity', v_quantity)
      );
    end loop;
    v_resolved_sections := v_resolved_sections || jsonb_build_array(
      jsonb_build_object(
        'sectionName', v_section_name,
        'sortOrder', coalesce(nullif(v_section->>'sortOrder', '')::smallint, v_section_sequence),
        'items', v_resolved_section_items
      )
    );
  end loop;

  perform public.save_engineering_project_structure(p_org_id, v_id, v_resolved_sections);

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'orders', v_id, 'saved_with_items_and_project', 'acesso-publico', p_order);
  return to_jsonb(v_order);
end;
$$;

create or replace function public.guard_order_item_project_quantity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_section_quantity integer;
begin
  if new.order_id is distinct from old.order_id and exists (
    select 1 from public.project_section_items psi
    where psi.organization_id = old.organization_id and psi.order_item_id = old.id
  ) then
    raise exception 'Um item vinculado às seções de engenharia não pode ser movido para outro pedido.';
  end if;
  if new.quantity is distinct from old.quantity then
    select coalesce(sum(psi.quantity), 0)::integer into v_section_quantity
    from public.project_section_items psi
    where psi.organization_id = old.organization_id and psi.order_item_id = old.id;
    if new.quantity < v_section_quantity then
      raise exception 'A quantidade do item não pode ficar abaixo da quantidade já distribuída nas seções.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_order_item_project_quantity on public.order_items;
create trigger trg_guard_order_item_project_quantity
before update of order_id, quantity on public.order_items
for each row execute function public.guard_order_item_project_quantity();

-- ---------------------------------------------------------------------------
-- Forma/peça: compatibilidade no banco, sem permitir forma na peça placa.
-- ---------------------------------------------------------------------------
create or replace function public.validate_piece_type_mold_role()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_piece_kind text;
begin
  select pt.piece_kind into v_piece_kind
  from public.piece_types pt
  where pt.organization_id = new.organization_id and pt.id = new.piece_type_id;
  if not found then raise exception 'Tipo de peça não encontrado nesta unidade.'; end if;
  if (new.role = 'braco' and v_piece_kind is distinct from 'braco')
    or (new.role in ('leito', 'lateral') and v_piece_kind not in ('pilar', 'viga'))
    or v_piece_kind = 'placa' then
    raise exception 'A forma selecionada não é compatível com o tipo de peça.';
  end if;
  if v_piece_kind is null then raise exception 'Classifique a peça antes de vincular uma forma.'; end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_piece_type_mold_role on public.piece_type_molds;
create trigger trg_validate_piece_type_mold_role
before insert or update on public.piece_type_molds
for each row execute function public.validate_piece_type_mold_role();

create or replace function public.lock_piece_type_mold_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_piece_type_id uuid;
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'A organização do vínculo de forma não pode ser alterada.';
  end if;
  if tg_op = 'UPDATE' and new.piece_type_id is distinct from old.piece_type_id then
    if old.piece_type_id < new.piece_type_id then
      perform pg_advisory_xact_lock(hashtext(old.piece_type_id::text)::bigint);
      perform pg_advisory_xact_lock(hashtext(new.piece_type_id::text)::bigint);
    else
      perform pg_advisory_xact_lock(hashtext(new.piece_type_id::text)::bigint);
      perform pg_advisory_xact_lock(hashtext(old.piece_type_id::text)::bigint);
    end if;
    if exists (
      select 1 from public.order_items oi
      join public.orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
      where oi.organization_id = old.organization_id and oi.piece_type_id in (old.piece_type_id, new.piece_type_id)
        and o.status not in ('entregue'::public.order_status, 'cancelado'::public.order_status, 'concluido'::public.order_status)
    ) then
      raise exception 'A compatibilidade não pode ser movida enquanto a peça estiver vinculada a pedido não encerrado.';
    end if;
  else
    v_piece_type_id := case when tg_op = 'DELETE' then old.piece_type_id else new.piece_type_id end;
    perform pg_advisory_xact_lock(hashtext(v_piece_type_id::text)::bigint);
  end if;
  if tg_op = 'UPDATE' and (new.role is distinct from old.role or new.catalog_code is distinct from old.catalog_code)
    and exists (
      select 1 from public.order_items oi
      join public.orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
      where oi.organization_id = old.organization_id and oi.piece_type_id = old.piece_type_id
        and o.status not in ('entregue'::public.order_status, 'cancelado'::public.order_status, 'concluido'::public.order_status)
    ) then
    raise exception 'A compatibilidade da peça não pode mudar enquanto estiver vinculada a pedido não encerrado.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_00_lock_piece_type_mold_mutation on public.piece_type_molds;
create trigger trg_00_lock_piece_type_mold_mutation
before insert or update or delete on public.piece_type_molds
for each row execute function public.lock_piece_type_mold_mutation();

create or replace function public.guard_piece_type_mold_active_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_piece_type_id uuid;
  v_role text;
  v_catalog_code text;
  v_current_code text;
begin
  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
    v_piece_type_id := old.piece_type_id;
    v_role := old.role;
    v_catalog_code := old.catalog_code;
  else
    v_organization_id := new.organization_id;
    v_piece_type_id := new.piece_type_id;
    v_role := new.role;
    v_catalog_code := new.catalog_code;
  end if;
  if exists (
    select 1
    from public.order_items oi
    join public.orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
    where oi.organization_id = v_organization_id and oi.piece_type_id = v_piece_type_id
      and o.status not in ('entregue'::public.order_status, 'cancelado'::public.order_status, 'concluido'::public.order_status)
  ) then
    select ptm.catalog_code into v_current_code
    from public.piece_type_molds ptm
    where ptm.organization_id = v_organization_id
      and ptm.piece_type_id = v_piece_type_id and ptm.role = v_role;
    if not found or v_current_code is distinct from v_catalog_code then
      raise exception 'A compatibilidade da peça não pode mudar enquanto estiver vinculada a um pedido não encerrado.';
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_guard_piece_type_mold_active_order on public.piece_type_molds;
create constraint trigger trg_guard_piece_type_mold_active_order
after insert or update or delete on public.piece_type_molds
deferrable initially deferred
for each row execute function public.guard_piece_type_mold_active_order();

create or replace function public.save_plate_type(p_org_id uuid, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_code text := upper(nullif(trim(p_record->>'code'), ''));
  v_name text := nullif(trim(p_record->>'name'), '');
  v_x numeric := nullif(p_record->>'dimensionXcm', '')::numeric;
  v_y numeric := nullif(p_record->>'dimensionYcm', '')::numeric;
  v_z numeric := nullif(p_record->>'dimensionZcm', '')::numeric;
  v_production_minutes integer := nullif(p_record->>'productionMinutesPerUnit', '')::integer;
  v_row public.piece_types;
begin
  if v_code is null or v_name is null then raise exception 'Informe código e nome da placa.'; end if;
  if v_x is null or v_y is null or v_z is null or v_x <= 0 or v_y <= 0 or v_z <= 0 then
    raise exception 'Informe X, Y e Z maiores que zero, em centímetros.';
  end if;
  if v_production_minutes is null or v_production_minutes <= 0 then
    raise exception 'O tempo de produção registrado precisa ser maior que zero.';
  end if;
  if v_id is not null then
    if not exists (
      select 1 from public.piece_types pt
      where pt.id = v_id and pt.organization_id = p_org_id and pt.piece_kind = 'placa'
    ) then raise exception 'Só é possível editar uma placa já cadastrada como placa.'; end if;
    if exists (
      select 1 from public.production_orders po
      join public.order_items oi on oi.id = po.order_item_id and oi.organization_id = po.organization_id
      where po.organization_id = p_org_id and oi.piece_type_id = v_id and po.status in ('planned', 'in_progress')
    ) then raise exception 'A medida da placa não pode mudar enquanto houver produção planejada ou em andamento.'; end if;
    if exists (select 1 from public.piece_type_molds where organization_id = p_org_id and piece_type_id = v_id)
      or exists (select 1 from public.mold_piece_types where organization_id = p_org_id and piece_type_id = v_id) then
      raise exception 'Placa não pode ter vínculo com uma forma.';
    end if;
    update public.piece_types set
      code = v_code,
      name = v_name,
      piece_kind = 'placa',
      dimension_x_cm = v_x,
      dimension_y_cm = v_y,
      dimension_z_cm = v_z,
      dimensions = format('%s × %s × %s cm', v_x, v_y, v_z),
      volume_cm3 = v_x * v_y * v_z,
      volume_m3 = (v_x * v_y * v_z) / 1000000,
      weight_kg = (v_x * v_y * v_z * 2.5) / 1000,
      production_minutes_per_unit = v_production_minutes,
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
  else
    insert into public.piece_types (
      organization_id, code, name, piece_kind, dimension_x_cm, dimension_y_cm, dimension_z_cm,
      dimensions, volume_cm3, volume_m3, weight_kg, production_minutes_per_unit, observations
    ) values (
      p_org_id, v_code, v_name, 'placa', v_x, v_y, v_z,
      format('%s × %s × %s cm', v_x, v_y, v_z), v_x * v_y * v_z,
      (v_x * v_y * v_z) / 1000000,
      (v_x * v_y * v_z * 2.5) / 1000,
      v_production_minutes, nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.validate_mold_position_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_configuration_changed boolean;
begin
  if new.configuration_kind is null then
    if new.braco_catalog_code is not null or new.leito_catalog_code is not null or new.lateral_catalog_code is not null then
      raise exception 'Uma posição sem configuração não pode apontar para medidas de forma.';
    end if;
  elsif new.configuration_kind = 'braco' then
    if new.braco_catalog_code is null or new.leito_catalog_code is not null or new.lateral_catalog_code is not null
      or not exists (select 1 from public.mold_catalog where code = new.braco_catalog_code and mold_type = 'BRACO') then
      raise exception 'A posição de braço exige somente uma medida BRAÇO válida.';
    end if;
  elsif new.configuration_kind = 'pilar_viga' then
    if new.braco_catalog_code is not null or new.leito_catalog_code is null or new.lateral_catalog_code is null
      or not exists (select 1 from public.mold_catalog where code = new.leito_catalog_code and mold_type = 'LEITO')
      or not exists (select 1 from public.mold_catalog where code = new.lateral_catalog_code and mold_type = 'LATERAL') then
      raise exception 'A posição de pilar/viga exige LEITO e LATERAL válidos.';
    end if;
  elsif new.configuration_kind = 'placa' then
    if new.braco_catalog_code is not null or new.leito_catalog_code is not null or new.lateral_catalog_code is not null then
      raise exception 'A posição de placa é uma bancada plana e não recebe forma.';
    end if;
  else
    raise exception 'Configuração de posição inválida.';
  end if;

  if tg_op = 'UPDATE' then
    v_configuration_changed :=
      new.configuration_kind is distinct from old.configuration_kind
      or new.braco_catalog_code is distinct from old.braco_catalog_code
      or new.leito_catalog_code is distinct from old.leito_catalog_code
      or new.lateral_catalog_code is distinct from old.lateral_catalog_code;
    if v_configuration_changed and exists (
      select 1 from public.allocations a
      join public.production_orders po on po.id = a.production_order_id and po.organization_id = a.organization_id
      where a.organization_id = old.organization_id and a.mold_position_id = old.id
        and a.status in ('planned', 'in_progress') and po.status in ('planned', 'in_progress')
    ) then
      raise exception 'Cancele ou reprograme as produções vinculadas antes de trocar a configuração da posição.';
    end if;
    if new.status is distinct from old.status and new.status <> 'em_producao' and exists (
      select 1 from public.allocations a
      join public.production_orders po on po.id = a.production_order_id and po.organization_id = a.organization_id
      where a.organization_id = old.organization_id and a.mold_position_id = old.id
        and a.status = 'in_progress' and po.status = 'in_progress'
    ) then
      raise exception 'A posição deve permanecer em produção enquanto houver concretagem em andamento.';
    end if;

    if v_configuration_changed or new.status is distinct from old.status or new.notes is distinct from old.notes then
      insert into public.mold_position_configuration_history (
        organization_id, mold_position_id, position_code, configuration_kind,
        braco_catalog_code, leito_catalog_code, lateral_catalog_code, status, notes,
        braco_measure_snapshot, leito_measure_snapshot, lateral_measure_snapshot
      )
      select old.organization_id, old.id, old.code, old.configuration_kind,
        old.braco_catalog_code, old.leito_catalog_code, old.lateral_catalog_code, old.status, old.notes,
        b.measure_label, l.measure_label, s.measure_label
      from (select 1) seed
      left join public.mold_catalog b on b.code = old.braco_catalog_code
      left join public.mold_catalog l on l.code = old.leito_catalog_code
      left join public.mold_catalog s on s.code = old.lateral_catalog_code;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_mold_position_change on public.mold_positions;
create trigger trg_validate_mold_position_change
before insert or update on public.mold_positions
for each row execute function public.validate_mold_position_change();

create or replace function public.save_mold_position(
  p_org_id uuid,
  p_code text,
  p_status text,
  p_configuration_kind text,
  p_braco_catalog_code text,
  p_leito_catalog_code text,
  p_lateral_catalog_code text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.mold_positions;
  v_braco text := nullif(trim(p_braco_catalog_code), '');
  v_leito text := nullif(trim(p_leito_catalog_code), '');
  v_lateral text := nullif(trim(p_lateral_catalog_code), '');
begin
  if p_code is null or p_code not in ('P01', 'P02', 'P03', 'P04') then raise exception 'Posição inválida.'; end if;
  if p_status is null or p_status not in ('disponivel', 'em_preparacao', 'em_producao', 'em_manutencao') then
    raise exception 'Status da posição inválido.';
  end if;
  if p_configuration_kind is null or p_configuration_kind not in ('braco', 'pilar_viga', 'placa') then
    raise exception 'Selecione Braço, Pilar/Viga ou Placa para a posição.';
  end if;

  select * into v_row from public.mold_positions
  where organization_id = p_org_id and code = p_code for update;
  if not found then raise exception 'A posição não existe nesta unidade.'; end if;

  if v_row.status is distinct from p_status
    or v_row.configuration_kind is distinct from p_configuration_kind
    or v_row.braco_catalog_code is distinct from v_braco
    or v_row.leito_catalog_code is distinct from v_leito
    or v_row.lateral_catalog_code is distinct from v_lateral
    or v_row.notes is distinct from nullif(trim(p_notes), '') then
    update public.mold_positions set
      status = p_status,
      configuration_kind = p_configuration_kind,
      braco_catalog_code = v_braco,
      leito_catalog_code = v_leito,
      lateral_catalog_code = v_lateral,
      notes = nullif(trim(p_notes), '')
    where id = v_row.id and organization_id = p_org_id
    returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

-- A alocação guarda o intervalo de ocupação da posição. Linhas antigas sem
-- horários são interpretadas como ocupação do dia inteiro no fuso da unidade.
drop index if exists public.allocations_one_active_position_day_idx;
create index if not exists allocations_active_position_interval_idx
  on public.allocations (organization_id, mold_position_id, occupied_from_at, occupied_until_at)
  where status in ('planned', 'in_progress');

create or replace function public.validate_allocation_compatibility_and_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_piece_type_id uuid;
  v_configuration text;
  v_braco text;
  v_leito text;
  v_lateral text;
  v_position_status text;
  v_timezone text;
  v_catalog_code text;
  v_start timestamptz;
  v_end timestamptz;
  v_cast_start timestamptz;
  v_cure_end timestamptz;
begin
  if new.status not in ('planned', 'in_progress') then return new; end if;
  if tg_op = 'UPDATE'
    and old.occupied_from_at is null and old.occupied_until_at is null
    and new.occupied_from_at is null and new.occupied_until_at is null
    and new.mold_position_id = old.mold_position_id
    and new.scheduled_date = old.scheduled_date
    and new.production_order_id = old.production_order_id
    and new.organization_id = old.organization_id
    and not exists (select 1 from public.production_order_steps s
      where s.organization_id = old.organization_id and s.production_order_id = old.production_order_id) then
    return new;
  end if;
  if tg_op = 'INSERT' and (new.occupied_from_at is null or new.occupied_until_at is null) then
    raise exception 'Uma nova alocação precisa registrar o início e o fim exatos da ocupação da posição.';
  end if;
  if tg_op = 'UPDATE' then
    if old.status not in ('planned', 'in_progress')
      and (new.occupied_from_at is null or new.occupied_until_at is null) then
      raise exception 'Uma alocação reativada precisa registrar o início e o fim exatos da ocupação da posição.';
    end if;
  end if;

  select pt.piece_kind, pt.id, mp.configuration_kind, mp.braco_catalog_code,
    mp.leito_catalog_code, mp.lateral_catalog_code, mp.status
  into v_kind, v_piece_type_id, v_configuration, v_braco, v_leito, v_lateral, v_position_status
  from public.production_orders po
  join public.order_items oi on oi.id = po.order_item_id and oi.organization_id = po.organization_id
  join public.piece_types pt on pt.id = oi.piece_type_id and pt.organization_id = oi.organization_id
  join public.mold_positions mp on mp.id = new.mold_position_id and mp.organization_id = new.organization_id
  where po.id = new.production_order_id and po.organization_id = new.organization_id;
  if not found then raise exception 'Produção ou posição não pertence à unidade informada.'; end if;
  perform pg_advisory_xact_lock(hashtext(v_piece_type_id::text)::bigint);
  for v_catalog_code in
    select code
    from unnest(array_remove(array[v_braco, v_leito, v_lateral], null)) as codes(code)
    order by code
  loop
    perform pg_advisory_xact_lock(hashtext('mold_catalog:' || v_catalog_code)::bigint);
  end loop;
  if v_position_status = 'em_manutencao' then raise exception 'A posição está em manutenção.'; end if;

  select cast_step.planned_start_at, cure_step.planned_end_at
  into v_cast_start, v_cure_end
  from public.production_order_steps cast_step
  join public.production_order_steps cure_step
    on cure_step.organization_id = cast_step.organization_id
    and cure_step.production_order_id = cast_step.production_order_id
  where cast_step.organization_id = new.organization_id
    and cast_step.production_order_id = new.production_order_id
    and cast_step.step_kind = 'concretagem'
    and cure_step.step_kind = 'cura';
  if v_cast_start is null or v_cure_end is null then
    raise exception 'Planeje concretagem e cura antes de alocar a posição.';
  end if;
  if new.occupied_from_at is null or new.occupied_until_at is null
    or new.occupied_from_at > v_cast_start or new.occupied_until_at < v_cure_end then
    raise exception 'A posição precisa permanecer reservada desde a concretagem até o fim da cura.';
  end if;

  if v_kind = 'braco' then
    if v_configuration is distinct from 'braco' or not exists (
      select 1 from public.piece_type_molds ptm
      where ptm.organization_id = new.organization_id
        and ptm.piece_type_id = v_piece_type_id
        and ptm.role = 'braco' and ptm.catalog_code = v_braco
    ) then raise exception 'A peça braço exige uma posição com a forma BRAÇO compatível.'; end if;
  elsif v_kind in ('pilar', 'viga') then
    if v_configuration is distinct from 'pilar_viga' or not exists (
      select 1 from public.piece_type_molds bed
      join public.piece_type_molds side
        on side.organization_id = bed.organization_id and side.piece_type_id = bed.piece_type_id
      where bed.organization_id = new.organization_id
        and bed.piece_type_id = v_piece_type_id
        and bed.role = 'leito' and bed.catalog_code = v_leito
        and side.role = 'lateral' and side.catalog_code = v_lateral
    ) then raise exception 'Pilar e viga exigem uma posição com LEITO e LATERAL compatíveis.'; end if;
  elsif v_kind = 'placa' then
    if v_configuration is distinct from 'placa' or v_braco is not null or v_leito is not null or v_lateral is not null then
      raise exception 'Placa só pode ser produzida em posição de bancada plana, sem forma.';
    end if;
  else
    raise exception 'Classifique o tipo da peça antes de programar sua produção.';
  end if;

  select o.timezone into v_timezone
  from public.organizations o where o.id = new.organization_id;
  v_start := coalesce(new.occupied_from_at, timezone(v_timezone, new.scheduled_date::timestamp));
  v_end := coalesce(new.occupied_until_at, timezone(v_timezone, (new.scheduled_date + 1)::timestamp));
  if v_end <= v_start then raise exception 'O intervalo de ocupação da posição é inválido.'; end if;

  perform pg_advisory_xact_lock(hashtext(new.mold_position_id::text)::bigint);
  if exists (
    select 1
    from public.allocations a
    where a.organization_id = new.organization_id
      and a.mold_position_id = new.mold_position_id
      and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and a.status in ('planned', 'in_progress')
      and v_start < coalesce(a.occupied_until_at, timezone(v_timezone, (a.scheduled_date + 1)::timestamp))
      and v_end > coalesce(a.occupied_from_at, timezone(v_timezone, a.scheduled_date::timestamp))
  ) then raise exception 'A posição já está ocupada durante o intervalo solicitado.'; end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_allocation_compatibility_and_overlap on public.allocations;
create trigger trg_validate_allocation_compatibility_and_overlap
before insert or update on public.allocations
for each row execute function public.validate_allocation_compatibility_and_overlap();

-- A placa preserva X×Y como área e Z como espessura; seu peso usa a mesma
-- densidade e o mesmo cálculo dimensional das peças existentes.
revoke all on function public.save_plate_type(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_plate_type(uuid, jsonb) to service_role;
revoke all on function public.save_engineering_project_structure(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_engineering_project_structure(uuid, uuid, jsonb) to service_role;
revoke all on function public.save_order_with_project(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_order_with_project(uuid, jsonb, jsonb, jsonb) to service_role;
revoke all on function public.save_mold_position(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_mold_position(uuid, text, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Planejamento não grava mais campos de pedido. Datas são derivadas das
-- production_orders; data solicitada continua sendo dado de orders.
-- ---------------------------------------------------------------------------
create or replace function public.commit_order_plan(p_org_id uuid, p_order_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  unit_row jsonb;
  step_row jsonb;
  item_id uuid;
  v_piece_type_id uuid;
  position_id uuid;
  production_order_id uuid;
  unit_sequence integer;
  step_sequence smallint;
  schedule_count integer := 0;
  allocation_count integer := 0;
  planned_end date;
  planned_start date;
  forecast_end date;
  adjustment_days integer;
begin
  if p_plan is null or jsonb_typeof(p_plan->'units') is distinct from 'array' then
    raise exception 'Plano inválido: units precisa ser uma lista';
  end if;
  if not exists (select 1 from public.orders where id = p_order_id and organization_id = p_org_id and is_active = true) then
    raise exception 'Pedido não encontrado';
  end if;
  if exists (
    select 1 from public.production_schedules
    where organization_id = p_org_id and order_id = p_order_id and status in ('in_progress', 'done')
  ) or exists (
    select 1 from public.production_orders
    where organization_id = p_org_id and order_id = p_order_id and status in ('in_progress', 'done', 'scrapped')
  ) or exists (
    select 1 from public.allocations a
    join public.production_orders po on po.id = a.production_order_id
    where po.organization_id = p_org_id and po.order_id = p_order_id and a.status in ('in_progress', 'done')
  ) then
    raise exception 'Pedido com produção iniciada ou concluída não pode ser replanejado.';
  end if;

  delete from public.allocations a using public.production_orders po
  where a.production_order_id = po.id and po.organization_id = p_org_id and po.order_id = p_order_id and a.status = 'planned';
  delete from public.production_orders
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';
  delete from public.production_schedules
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';

  for unit_row in select value from jsonb_array_elements(p_plan->'units') loop
    item_id := nullif(unit_row->>'itemId', '')::uuid;
    v_piece_type_id := nullif(unit_row->>'pieceTypeId', '')::uuid;
    unit_sequence := nullif(unit_row->>'unitSequence', '')::integer;
    if item_id is null or unit_sequence is null or unit_sequence < 1 then
      raise exception 'Unidade programada sem item ou sequência válida.';
    end if;
    if not exists (
      select 1 from public.order_items oi
      where oi.id = item_id and oi.organization_id = p_org_id and oi.order_id = p_order_id and oi.piece_type_id = v_piece_type_id
    ) then raise exception 'Item da programação não pertence ao pedido informado.'; end if;
    if not exists (
      select 1 from public.calendar_days cd
      where cd.organization_id = p_org_id and cd.date = (unit_row->>'castDate')::date and cd.is_working = true
    ) then raise exception 'A concretagem precisa ocorrer em um dia útil do calendário.'; end if;
    select mp.id into position_id from public.mold_positions mp
    where mp.organization_id = p_org_id and mp.code = unit_row->>'positionCode' and mp.status <> 'em_manutencao';
    if position_id is null then raise exception 'Posição inexistente ou em manutenção.'; end if;

    insert into public.production_orders (
      organization_id, order_id, order_item_id, unit_sequence,
      planned_cast_date, planned_cure_start_date, planned_cure_end_date,
      planned_finish_date, planned_end_date, forecast_end_date,
      curing_days, production_minutes_snapshot, status
    ) values (
      p_org_id, p_order_id, item_id, unit_sequence,
      (unit_row->>'castDate')::date, (unit_row->>'cureStartDate')::date,
      (unit_row->>'cureEndDate')::date, (unit_row->>'finishDate')::date,
      (unit_row->>'plannedEndDate')::date, (unit_row->>'plannedEndDate')::date,
      (unit_row->>'curingDays')::smallint,
      coalesce((unit_row->>'productionMinutesSnapshot')::integer, 0), 'planned'
    ) returning id into production_order_id;

    if jsonb_typeof(unit_row->'steps') = 'array' then
      for step_row in select value from jsonb_array_elements(unit_row->'steps') loop
        step_sequence := nullif(step_row->>'sequence', '')::smallint;
        insert into public.production_order_steps (
          organization_id, production_order_id, step_kind, sequence, duration_minutes,
          planned_start_at, planned_end_at, status, notes
        ) values (
          p_org_id, production_order_id, step_row->>'stepKind', step_sequence,
          nullif(step_row->>'durationMinutes', '')::integer,
          nullif(step_row->>'plannedStartAt', '')::timestamptz,
          nullif(step_row->>'plannedEndAt', '')::timestamptz,
          coalesce(nullif(step_row->>'status', ''), 'planned'),
          nullif(trim(step_row->>'notes'), '')
        );
      end loop;
    end if;

    insert into public.allocations (
      organization_id, production_order_id, mold_position_id, scheduled_date,
      occupied_from_at, occupied_until_at, status
    ) values (
      p_org_id, production_order_id, position_id, (unit_row->>'castDate')::date,
      nullif(unit_row->>'occupiedFromAt', '')::timestamptz,
      nullif(unit_row->>'occupiedUntilAt', '')::timestamptz, 'planned'
    );
    allocation_count := allocation_count + 1;
  end loop;

  insert into public.production_schedules (
    organization_id, order_id, order_item_id, piece_type_id,
    work_date, planned_quantity, planned_minutes, status
  )
  select p_org_id, po.order_id, po.order_item_id, oi.piece_type_id,
    po.planned_cast_date, count(*)::integer, sum(po.production_minutes_snapshot)::integer, 'planned'
  from public.production_orders po
  join public.order_items oi on oi.id = po.order_item_id
  where po.organization_id = p_org_id and po.order_id = p_order_id and po.status = 'planned'
  group by po.order_id, po.order_item_id, oi.piece_type_id, po.planned_cast_date;
  get diagnostics schedule_count = row_count;

  planned_start := nullif(p_plan->>'effectiveStartDate', '')::date;
  planned_end := nullif(p_plan->>'plannedEndDate', '')::date;
  select coalesce(sum(impact_days), 0)::integer into adjustment_days
  from public.delay_adjustments where organization_id = p_org_id and order_id = p_order_id;
  forecast_end := case when planned_end is null then null else planned_end + adjustment_days end;
  update public.production_orders
  set forecast_end_date = planned_end_date + adjustment_days
  where organization_id = p_org_id and order_id = p_order_id and status = 'planned';

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'planning', p_order_id, 'plan_committed', 'acesso-publico', p_plan);
  return jsonb_build_object(
    'orderId', p_order_id, 'unitCount', allocation_count, 'scheduleCount', schedule_count,
    'plannedStartDate', planned_start, 'plannedEndDate', planned_end, 'forecastEndDate', forecast_end
  );
end;
$$;

-- Grava obra, pedido, item, tipo de peca, compatibilidade e fila de producao
-- em uma transacao. O navegador chama esta funcao apenas pela Edge Function.
create or replace function public.create_order_piece_registration(
  p_org_id uuid,
  p_registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work jsonb := p_registration->'work';
  v_order jsonb := p_registration->'order';
  v_item jsonb := p_registration->'item';
  v_piece jsonb := p_registration->'piece';
  v_plans jsonb := p_registration->'plans';
  v_calendar_days jsonb := p_registration->'planningCalendarDays';
  v_mold_catalogs jsonb := v_piece->'moldCatalogs';
  v_geometry_parts jsonb := coalesce(v_piece->'geometryParts', '[]'::jsonb);
  v_order_id uuid := nullif(p_registration->>'orderId', '')::uuid;
  v_item_id uuid := nullif(p_registration->>'itemId', '')::uuid;
  v_piece_id uuid := nullif(p_registration->>'pieceId', '')::uuid;
  v_work_number text;
  v_work_name text;
  v_client_name text;
  v_address text;
  v_responsible_name text;
  v_work_start_date date;
  v_work_due_date date;
  v_order_start_date date;
  v_order_due_date date;
  v_order_status public.order_status;
  v_client_id uuid;
  v_work_id uuid;
  v_order_number text;
  v_next_order_number numeric;
  v_piece_code text;
  v_piece_name text;
  v_piece_kind text;
  v_piece_observations text;
  v_item_observations text;
  v_order_observations text;
  v_quantity integer;
  v_sequence integer;
  v_x numeric;
  v_y numeric;
  v_z numeric;
  v_part jsonb;
  v_part_x numeric;
  v_part_y numeric;
  v_part_z numeric;
  v_part_quantity numeric;
  v_part_factor numeric;
  v_part_sign numeric;
  v_part_shape text;
  v_part_operation text;
  v_volume_cm3 numeric := 0;
  v_volume_m3 numeric;
  v_weight_kg numeric;
  v_production_minutes integer;
  v_configured_kind_count integer;
  v_valid_production_minutes_count integer;
  v_catalog_count integer;
  v_catalog_code text;
  v_day jsonb;
  v_queue_result jsonb := '{}'::jsonb;
  v_target_commit jsonb;
  v_target_was_planned boolean := false;
  v_position_codes text[] := array[]::text[];
begin
  if p_org_id is null or p_registration is null or jsonb_typeof(p_registration) is distinct from 'object' then
    raise exception 'Envie a unidade e os dados do cadastro em formato valido.';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception 'Unidade nao encontrada.';
  end if;

  -- Serializa a geracao de pedidos e o reuso/criacao da obra e do cliente.
  perform pg_advisory_xact_lock(hashtext(p_org_id::text), hashtext('create_order_piece_registration'));

  if jsonb_typeof(v_work) is distinct from 'object'
    or jsonb_typeof(v_order) is distinct from 'object'
    or jsonb_typeof(v_item) is distinct from 'object'
    or jsonb_typeof(v_piece) is distinct from 'object' then
    raise exception 'Obra, pedido, item e peca sao obrigatorios.';
  end if;
  if jsonb_typeof(v_plans) is distinct from 'array'
    or jsonb_typeof(v_calendar_days) is distinct from 'array' then
    raise exception 'Planos e dias do calendario precisam ser listas.';
  end if;
  if jsonb_array_length(v_plans) > 1000 or jsonb_array_length(v_calendar_days) > 5000 then
    raise exception 'O cadastro excede o limite de planos ou dias de calendario.';
  end if;
  if v_order_id is null or v_item_id is null or v_piece_id is null then
    raise exception 'Os identificadores do pedido, item e peca sao obrigatorios.';
  end if;

  v_work_number := upper(nullif(trim(v_work->>'workNumber'), ''));
  v_work_name := nullif(trim(v_work->>'name'), '');
  v_client_name := nullif(trim(v_work->>'clientName'), '');
  v_address := nullif(trim(v_work->>'address'), '');
  v_responsible_name := nullif(trim(v_work->>'responsibleName'), '');
  v_work_start_date := nullif(v_work->>'startDate', '')::date;
  v_work_due_date := nullif(v_work->>'requestedDueDate', '')::date;
  v_order_start_date := nullif(v_order->>'startDate', '')::date;
  v_order_due_date := nullif(v_order->>'requestedDueDate', '')::date;
  v_order_status := coalesce(nullif(v_order->>'status', ''), 'orcamento')::public.order_status;

  if v_work_number is null or length(v_work_number) > 80
    or v_work_name is null or length(v_work_name) > 180
    or v_client_name is null or length(v_client_name) > 180
    or v_address is null or length(v_address) > 300
    or v_responsible_name is null or length(v_responsible_name) > 180
    or v_work_start_date is null then
    raise exception 'Preencha numero, nome, cliente, endereco, responsavel e inicio da obra.';
  end if;
  if v_work_due_date is null or v_work_due_date < v_work_start_date then
    raise exception 'O prazo da obra deve ser informado e nao pode anteceder seu inicio.';
  end if;
  if v_order_start_date is distinct from v_work_start_date
    or v_order_due_date is distinct from v_work_due_date then
    raise exception 'As datas do pedido precisam corresponder as datas informadas para a obra.';
  end if;
  if v_order_status <> 'orcamento'::public.order_status then
    raise exception 'Um novo pedido deste cadastro deve iniciar como orcamento.';
  end if;

  v_quantity := nullif(v_item->>'quantity', '')::integer;
  v_sequence := coalesce(nullif(v_item->>'sequence', '')::integer, 1);
  if v_quantity is null or v_quantity < 1 or v_sequence <> 1 then
    raise exception 'Informe quantidade positiva e sequencia 1 para o novo item.';
  end if;

  v_piece_code := upper(nullif(trim(v_piece->>'code'), ''));
  v_piece_name := nullif(trim(v_piece->>'name'), '');
  v_piece_kind := nullif(trim(v_piece->>'pieceKind'), '');
  v_piece_observations := nullif(trim(v_piece->>'observations'), '');
  v_item_observations := nullif(trim(v_item->>'observations'), '');
  v_order_observations := nullif(trim(v_order->>'observations'), '');
  v_x := nullif(v_piece->>'dimensionXcm', '')::numeric;
  v_y := nullif(v_piece->>'dimensionYcm', '')::numeric;
  v_z := nullif(v_piece->>'dimensionZcm', '')::numeric;
  if v_piece_code is null or length(v_piece_code) > 60
    or v_piece_name is null or length(v_piece_name) > 180 then
    raise exception 'Informe codigo e nome validos para a peca.';
  end if;
  if v_piece_kind is null or v_piece_kind not in ('braco', 'pilar', 'viga') then
    raise exception 'O tipo da peca deve ser braco, pilar ou viga.';
  end if;
  if v_x is null or v_y is null or v_z is null
    or least(v_x, v_y, v_z) <= 0 or greatest(v_x, v_y, v_z) > 1000000 then
    raise exception 'Informe largura, comprimento e espessura positivos em centimetros.';
  end if;
  if jsonb_typeof(v_geometry_parts) is distinct from 'array'
    or jsonb_array_length(v_geometry_parts) > 100 then
    raise exception 'A composicao geometrica precisa ser uma lista de ate 100 partes.';
  end if;

  -- Recalcula as metricas no banco; os valores recebidos da Edge Function nao sao autoridade.
  if jsonb_array_length(v_geometry_parts) = 0 then
    v_volume_cm3 := v_x * v_y * v_z;
  else
    for v_part in select value from jsonb_array_elements(v_geometry_parts)
    loop
      if jsonb_typeof(v_part) is distinct from 'object' then
        raise exception 'Cada parte geometrica precisa ser um objeto.';
      end if;
      v_part_shape := coalesce(nullif(v_part->>'shape', ''), 'rectangular_prism');
      v_part_operation := coalesce(nullif(v_part->>'operation', ''), 'add');
      v_part_x := nullif(v_part->>'x', '')::numeric;
      v_part_y := nullif(v_part->>'y', '')::numeric;
      v_part_z := nullif(v_part->>'z', '')::numeric;
      v_part_quantity := coalesce(nullif(v_part->>'quantity', '')::numeric, 1);
      if v_part_shape not in ('rectangular_prism', 'triangular_prism')
        or v_part_operation not in ('add', 'subtract') then
        raise exception 'A forma ou operacao da parte geometrica e invalida.';
      end if;
      if v_part_x is null or v_part_y is null or v_part_z is null
        or least(v_part_x, v_part_y, v_part_z) <= 0
        or greatest(v_part_x, v_part_y, v_part_z) > 1000000 then
        raise exception 'Cada parte geometrica precisa de tres dimensoes positivas em centimetros.';
      end if;
      if v_part_quantity <> trunc(v_part_quantity) or v_part_quantity < 1 or v_part_quantity > 1000 then
        raise exception 'A quantidade de cada parte geometrica deve ser um inteiro entre 1 e 1000.';
      end if;
      v_part_factor := case when v_part_shape = 'triangular_prism' then 0.5 else 1 end;
      v_part_sign := case when v_part_operation = 'subtract' then -1 else 1 end;
      v_volume_cm3 := v_volume_cm3
        + v_part_sign * v_part_x * v_part_y * v_part_z * v_part_factor * v_part_quantity;
    end loop;
  end if;
  if v_volume_cm3 <= 0 then
    raise exception 'O volume final da peca deve ser maior que zero.';
  end if;
  v_volume_m3 := v_volume_cm3 / 1000000;
  v_weight_kg := v_volume_cm3 * 2.5 / 1000;

  -- Exige os tres tempos de producao por tipo e preserva o snapshot do plano.
  select count(cc.constant_key)::integer,
    (count(*) filter (where cc.unit = 'min/un' and cc.numeric_value > 0
      and cc.numeric_value = trunc(cc.numeric_value)
      and cc.numeric_value <= 2147483647))::integer
  into v_configured_kind_count, v_valid_production_minutes_count
  from (values
    ('production_minutes_braco'),
    ('production_minutes_pilar'),
    ('production_minutes_viga')
  ) as required(constant_key)
  left join public.calculation_constants cc
    on cc.organization_id = p_org_id and cc.constant_key = required.constant_key;
  if v_configured_kind_count <> 3 or v_valid_production_minutes_count <> 3 then
    raise exception 'Configure os tempos positivos em min/un para braco, pilar e viga antes do cadastro.';
  end if;
  select cc.numeric_value::integer into v_production_minutes
  from public.calculation_constants cc
  where cc.organization_id = p_org_id
    and cc.constant_key = 'production_minutes_' || v_piece_kind
    and cc.unit = 'min/un'
    and cc.numeric_value > 0
    and cc.numeric_value = trunc(cc.numeric_value)
    and cc.numeric_value <= 2147483647;
  if v_production_minutes is null
    or nullif(v_piece->>'productionMinutesPerUnit', '')::integer is distinct from v_production_minutes then
    raise exception 'O tempo por unidade mudou; atualize o cadastro e tente novamente.';
  end if;

  if jsonb_typeof(v_mold_catalogs) is distinct from 'object' then
    raise exception 'Selecione a forma compativel com a peca.';
  end if;
  if v_piece_kind = 'braco' then
    v_catalog_code := nullif(trim(v_mold_catalogs->>'braco'), '');
    select count(*)::integer into v_catalog_count
    from public.mold_catalog c where c.code = v_catalog_code and c.mold_type = 'BRACO';
    if v_catalog_count <> 1 then
      raise exception 'Braco exige uma forma fixa BRACO valida do catalogo.';
    end if;
  else
    if nullif(trim(v_mold_catalogs->>'braco'), '') is not null then
      raise exception 'A forma fixa BRACO so e permitida para peca do tipo braco.';
    end if;
    select count(*)::integer into v_catalog_count
    from (values
      ('LEITO'::text, nullif(trim(v_mold_catalogs->>'leito'), '')),
      ('LATERAL'::text, nullif(trim(v_mold_catalogs->>'lateral'), ''))
    ) as required(mold_type, code)
    join public.mold_catalog c on c.mold_type = required.mold_type and c.code = required.code;
    if v_catalog_count <> 2 then
      raise exception 'Pilar e viga exigem formas LEITO e LATERAL validas do catalogo.';
    end if;
  end if;

  -- Usa ou cria o cliente sem introduzir uma tabela de clientes paralela.
  select c.id into v_client_id
  from public.clients c
  where c.organization_id = p_org_id and c.is_active = true
    and lower(trim(c.name)) = lower(v_client_name)
  order by c.created_at, c.id
  limit 1
  for update;
  if v_client_id is null then
    insert into public.clients (organization_id, name)
    values (p_org_id, v_client_name)
    returning id into v_client_id;
  end if;

  -- Reutiliza a obra pelo numero; a trigger da migration 008 sincroniza pedidos existentes.
  select w.id into v_work_id
  from public.works w
  where w.organization_id = p_org_id and w.work_number = v_work_number
  for update;
  if v_work_id is null then
    insert into public.works (
      organization_id, work_number, name, client_id, address, responsible_name,
      start_date, requested_due_date, status
    ) values (
      p_org_id, v_work_number, v_work_name, v_client_id, v_address, v_responsible_name,
      v_work_start_date, v_work_due_date, 'planejamento'
    ) returning id into v_work_id;
  else
    update public.works set
      name = v_work_name,
      client_id = v_client_id,
      address = v_address,
      responsible_name = v_responsible_name,
      start_date = v_work_start_date,
      requested_due_date = v_work_due_date,
      is_active = true
    where id = v_work_id and organization_id = p_org_id;
  end if;

  select coalesce(max(substring(o.order_number from 5)::numeric), 0) + 1
  into v_next_order_number
  from public.orders o
  where o.organization_id = p_org_id and o.order_number ~* '^PED-[0-9]+$';
  v_order_number := 'PED-' || lpad(v_next_order_number::text, 4, '0');

  insert into public.piece_types (
    id, organization_id, code, name, piece_kind,
    dimension_x_cm, dimension_y_cm, dimension_z_cm, dimensions,
    volume_cm3, volume_m3, weight_kg, production_minutes_per_unit,
    observations, custom_fields
  ) values (
    v_piece_id, p_org_id, v_piece_code, v_piece_name, v_piece_kind,
    v_x, v_y, v_z, format('%s x %s x %s cm', v_x, v_y, v_z),
    v_volume_cm3, v_volume_m3, v_weight_kg, v_production_minutes,
    v_piece_observations, jsonb_build_object('geometryParts', v_geometry_parts)
  );

  if v_piece_kind = 'braco' then
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values (p_org_id, v_piece_id, 'braco', v_mold_catalogs->>'braco');
  else
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values
      (p_org_id, v_piece_id, 'leito', v_mold_catalogs->>'leito'),
      (p_org_id, v_piece_id, 'lateral', v_mold_catalogs->>'lateral');
  end if;

  insert into public.orders (
    id, organization_id, order_number, work_id, client_id,
    start_date, requested_due_date, status, observations
  ) values (
    v_order_id, p_org_id, v_order_number, v_work_id, v_client_id,
    v_work_start_date, v_work_due_date, v_order_status, v_order_observations
  );
  insert into public.order_items (
    id, organization_id, order_id, piece_type_id, quantity,
    production_minutes_snapshot, sequence, observations
  ) values (
    v_item_id, p_org_id, v_order_id, v_piece_id, v_quantity,
    v_production_minutes, v_sequence, v_item_observations
  );

  -- O planejador calcula sem gravar; a RPC persiste os dias usados no mesmo commit.
  for v_day in select value from jsonb_array_elements(v_calendar_days)
  loop
    insert into public.calendar_days (
      organization_id, date, is_working, capacity_minutes, source, exception_id, note, generated_at
    ) values (
      p_org_id,
      (v_day->>'date')::date,
      (v_day->>'is_working')::boolean,
      (v_day->>'capacity_minutes')::integer,
      coalesce(nullif(v_day->>'source', ''), 'regra'),
      nullif(v_day->>'exception_id', '')::uuid,
      nullif(trim(v_day->>'note'), ''),
      now()
    )
    on conflict (organization_id, date) do update set
      is_working = excluded.is_working,
      capacity_minutes = excluded.capacity_minutes,
      source = excluded.source,
      exception_id = excluded.exception_id,
      note = excluded.note,
      generated_at = excluded.generated_at;
  end loop;

  if jsonb_array_length(v_plans) > 0 then
    v_queue_result := public.commit_planning_queue(p_org_id, v_plans);
    select exists (
      select 1 from jsonb_array_elements(v_plans) as plan(value)
      where plan.value->>'orderId' = v_order_id::text
    ) into v_target_was_planned;
    select result.value into v_target_commit
    from jsonb_array_elements(coalesce(v_queue_result->'orders', '[]'::jsonb)) as result(value)
    where result.value->>'orderId' = v_order_id::text;
  end if;

  select coalesce(array_agg(distinct mp.code order by mp.code), array[]::text[])
  into v_position_codes
  from public.production_orders po
  join public.allocations a
    on a.organization_id = po.organization_id and a.production_order_id = po.id
  join public.mold_positions mp
    on mp.organization_id = a.organization_id and mp.id = a.mold_position_id
  where po.organization_id = p_org_id and po.order_id = v_order_id;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (
    p_org_id, 'orders', v_order_id, 'registered_with_piece', 'acesso-publico',
    jsonb_build_object(
      'orderNumber', v_order_number, 'workId', v_work_id,
      'itemId', v_item_id, 'pieceId', v_piece_id, 'positionCodes', to_jsonb(v_position_codes)
    )
  );

  return jsonb_build_object(
    'orderId', v_order_id,
    'orderNumber', v_order_number,
    'workId', v_work_id,
    'pieceId', v_piece_id,
    'itemId', v_item_id,
    'positionCodes', to_jsonb(v_position_codes),
    'planning', jsonb_build_object(
      'committed', true,
      'waitingForPosition', not v_target_was_planned,
      'plannedUnitCount', coalesce(nullif(v_target_commit->>'unitCount', '')::integer, 0)
    )
  );
end;
$$;

create or replace function public.save_delay_adjustment(
  p_org_id uuid, p_order_id uuid, p_reason text, p_occurred_on date,
  p_adjusted_forecast_end date, p_recorded_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_end date;
  impact integer;
  adjustment_id uuid;
  total_adjustment integer;
  planned_end date;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'Informe o motivo do ajuste.'; end if;
  select max(po.forecast_end_date), max(po.planned_end_date)
  into previous_end, planned_end
  from public.production_orders po
  where po.organization_id = p_org_id and po.order_id = p_order_id and po.status <> 'cancelled';
  previous_end := coalesce(previous_end, planned_end);
  if previous_end is null then raise exception 'O pedido precisa ter produção planejada antes do ajuste.'; end if;
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
  update public.production_orders
  set forecast_end_date = planned_end_date + total_adjustment
  where organization_id = p_org_id and order_id = p_order_id and status <> 'cancelled';

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'delay_adjustments', adjustment_id, 'created',
    coalesce(nullif(trim(p_recorded_by), ''), 'acesso-publico'),
    jsonb_build_object('orderId', p_order_id, 'reason', trim(p_reason), 'occurredOn', p_occurred_on,
      'impactDays', impact, 'previousForecastEnd', previous_end, 'adjustedForecastEnd', p_adjusted_forecast_end));
  return jsonb_build_object(
    'id', adjustment_id, 'orderId', p_order_id, 'impactDays', impact,
    'previousForecastEnd', previous_end, 'adjustedForecastEnd', p_adjusted_forecast_end
  );
end;
$$;

create or replace view public.v_order_progress
with (security_invoker = true)
as
select o.organization_id, o.id as order_id, o.order_number, o.client_id, o.start_date,
  o.requested_due_date, plan.planned_end_date, o.status,
  coalesce(items.requested_quantity, 0::bigint)::integer as requested_quantity,
  coalesce(schedule.planned_quantity, 0::bigint)::integer as planned_quantity,
  coalesce(schedule.actual_quantity, 0::bigint)::integer as actual_quantity,
  case when coalesce(items.requested_quantity, 0::bigint) = 0 then 0::numeric
    else round(coalesce(schedule.actual_quantity, 0::bigint)::numeric / items.requested_quantity::numeric * 100::numeric, 2)
  end as completion_percent,
  plan.forecast_end_date
from public.orders o
left join lateral (
  select max(po.planned_end_date) as planned_end_date,
    max(po.forecast_end_date) as forecast_end_date
  from public.production_orders po
  where po.organization_id = o.organization_id and po.order_id = o.id and po.status <> 'cancelled'
) plan on true
left join lateral (
  select sum(oi.quantity) as requested_quantity
  from public.order_items oi where oi.organization_id = o.organization_id and oi.order_id = o.id
) items on true
left join lateral (
  select sum(ps.planned_quantity) filter (where ps.status <> 'cancelled'::public.production_schedule_status) as planned_quantity,
    sum(ps.actual_quantity) as actual_quantity
  from public.production_schedules ps
  where ps.organization_id = o.organization_id and ps.order_id = o.id
) schedule on true
where o.is_active = true;

-- audit_logs já é o histórico central de mudanças; não cria tabelas paralelas.
create or replace function public.audit_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new)->>'status') is distinct from (to_jsonb(old)->>'status') then
    insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
    values (
      (to_jsonb(new)->>'organization_id')::uuid,
      tg_table_name,
      (to_jsonb(new)->>'id')::uuid,
      'status_changed',
      'acesso-publico',
      jsonb_build_object('from', to_jsonb(old)->>'status', 'to', to_jsonb(new)->>'status')
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_orders_status_audit on public.orders;
create trigger trg_orders_status_audit
after update of status on public.orders
for each row execute function public.audit_status_transition();
drop trigger if exists trg_production_orders_status_audit on public.production_orders;
create trigger trg_production_orders_status_audit
after update of status on public.production_orders
for each row execute function public.audit_status_transition();

-- ---------------------------------------------------------------------------
-- Segurança compatível com o modelo sem login: somente service_role lê/grava.
-- As Edge Functions continuam sendo a fronteira de acesso do site.
-- ---------------------------------------------------------------------------
alter table public.production_order_steps enable row level security;
alter table public.calculation_constants enable row level security;
alter table public.engineering_projects enable row level security;
alter table public.project_sections enable row level security;
alter table public.project_section_items enable row level security;

revoke all on public.production_order_steps, public.calculation_constants,
  public.engineering_projects, public.project_sections, public.project_section_items
  from public, anon, authenticated;
grant select, insert, update, delete on public.production_order_steps, public.calculation_constants to service_role;
grant select on public.engineering_projects, public.project_sections, public.project_section_items to service_role;
revoke insert, update, delete on public.engineering_projects, public.project_sections, public.project_section_items from service_role;

revoke all on public.v_stock_balances, public.v_stock_reservations, public.v_piece_inventory,
  public.v_capacity_daily, public.v_order_progress, public.piece_mold_combinations
  from public, anon, authenticated;
grant select on public.v_stock_balances, public.v_stock_reservations, public.v_piece_inventory,
  public.v_capacity_daily, public.v_order_progress, public.piece_mold_combinations to service_role;
alter view public.v_stock_balances set (security_invoker = true);
alter view public.v_stock_reservations set (security_invoker = true);
alter view public.v_piece_inventory set (security_invoker = true);
alter view public.v_capacity_daily set (security_invoker = true);

revoke all on function public.rls_auto_enable() from public, anon, authenticated;
alter function public.set_updated_at() set search_path = public, pg_temp;
revoke all on function public.commit_order_plan(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_order_plan(uuid, uuid, jsonb) to service_role;
revoke all on function public.create_order_piece_registration(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_order_piece_registration(uuid, jsonb) to service_role;
revoke all on function public.save_delay_adjustment(uuid, uuid, text, date, date, text) from public, anon, authenticated;
grant execute on function public.save_delay_adjustment(uuid, uuid, text, date, date, text) to service_role;
revoke all on function public.validate_mold_preparation() from public, anon, authenticated;
revoke all on function public.validate_production_order_step() from public, anon, authenticated;
revoke all on function public.require_core_production_steps() from public, anon, authenticated;
revoke all on function public.validate_allocation_compatibility_and_overlap() from public, anon, authenticated;
revoke all on function public.validate_mold_position_change() from public, anon, authenticated;
revoke all on function public.validate_project_section_item() from public, anon, authenticated;
revoke all on function public.assert_project_item_coverage(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enforce_project_item_coverage_after_change() from public, anon, authenticated;
grant execute on function public.assert_project_item_coverage(uuid, uuid) to service_role;
grant execute on function public.enforce_project_item_coverage_after_change() to service_role;
revoke all on function public.guard_engineering_project_order_change() from public, anon, authenticated;
revoke all on function public.guard_project_section_parent_change() from public, anon, authenticated;
revoke all on function public.guard_order_item_project_quantity() from public, anon, authenticated;
revoke all on function public.validate_piece_type_mold_role() from public, anon, authenticated;
revoke all on function public.lock_piece_type_mold_mutation() from public, anon, authenticated;
revoke all on function public.guard_piece_type_mold_active_order() from public, anon, authenticated;
revoke all on function public.guard_mold_catalog_update() from public, anon, authenticated;
revoke all on function public.audit_mold_catalog_update() from public, anon, authenticated;
revoke all on function public.audit_calculation_constant_change() from public, anon, authenticated;
revoke all on function public.audit_status_transition() from public, anon, authenticated;

commit;
