-- PRELUX · proposta de modelo da Etapa 1
-- Este rascunho cria um schema isolado para revisão. Não aplicar no banco
-- atual nem publicar antes da confirmação das premissas e da migração de dados.
-- A implementação final deverá migrar os dados existentes e expor as tabelas
-- no schema público consumido pelas Edge Functions.

create extension if not exists pgcrypto;
create schema if not exists prelux_stage1_proposal;
set search_path = prelux_stage1_proposal, public;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now()
);

create table calendar_settings (
  organization_id uuid primary key references organizations(id) on delete cascade,
  weekdays smallint[] not null default array[1,2,3,4,5]::smallint[],
  updated_at timestamptz not null default now()
);

create table calendar_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('feriado_nacional','feriado_local','personalizada','dia_extra','parada','manutencao','folga_coletiva')),
  start_date date not null,
  end_date date not null,
  is_working boolean not null,
  priority smallint not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index calendar_exceptions_period_idx
  on calendar_exceptions (organization_id, start_date, end_date, priority desc);

create table calendar_days (
  organization_id uuid not null references organizations(id) on delete cascade,
  date date not null,
  is_working boolean not null,
  source text not null check (source in ('regra','excecao','manual')),
  exception_id uuid references calendar_exceptions(id) on delete set null,
  note text,
  generated_at timestamptz not null default now(),
  primary key (organization_id, date)
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  tax_id text,
  contact_name text,
  phone text,
  email text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_name_idx on clients (organization_id, name);

create table works (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete restrict,
  work_number text,
  name text not null,
  address text,
  responsible_name text,
  contractual_due_date date,
  status text not null default 'planejamento'
    check (status in ('planejamento','ativa','concluida','cancelada')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, work_number)
);
create index works_client_idx on works (organization_id, client_id, status);

create table piece_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('BRACO','PILAR','VIGA')),
  name text not null check (name in ('Braço','Pilar','Viga')),
  is_active boolean not null default true,
  check ((code = 'BRACO' and name = 'Braço') or
         (code = 'PILAR' and name = 'Pilar') or
         (code = 'VIGA' and name = 'Viga'))
);

create table mold_catalog (
  id uuid primary key default gen_random_uuid(),
  mold_type text not null check (mold_type in ('LEITO','LATERAL','BRACO')),
  dimension_x_cm numeric(6,2) not null,
  dimension_y_cm numeric(6,2),
  measure_label text not null,
  is_active boolean not null default true,
  unique (mold_type, measure_label),
  check (
    (mold_type = 'LEITO' and dimension_y_cm is null and dimension_x_cm in (20,25,30,35,40,50,60)) or
    (mold_type = 'LATERAL' and dimension_y_cm is null and dimension_x_cm in (25,30,40,50,60)) or
    (mold_type = 'BRACO' and (dimension_x_cm, dimension_y_cm) in ((25,35),(25,52),(30,60)))
  )
);

create table pieces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  piece_type_id uuid not null references piece_types(id) on delete restrict,
  code text not null,
  name text not null,
  dimension_x_cm numeric(12,2) not null check (dimension_x_cm > 0),
  dimension_y_cm numeric(12,2) not null check (dimension_y_cm > 0),
  dimension_z_cm numeric(12,2) not null check (dimension_z_cm > 0),
  production_minutes_recorded integer not null check (production_minutes_recorded > 0),
  curing_days smallint not null default 2 check (curing_days > 0),
  critical_stock_threshold integer check (critical_stock_threshold is null or critical_stock_threshold >= 0),
  volume_cm3 numeric(24,2) generated always as
    (dimension_x_cm * dimension_y_cm * dimension_z_cm) stored,
  volume_m3 numeric(18,9) generated always as
    ((dimension_x_cm * dimension_y_cm * dimension_z_cm) / 1000000) stored,
  weight_kg numeric(24,5) generated always as
    ((dimension_x_cm * dimension_y_cm * dimension_z_cm * 2.5) / 1000) stored,
  custom_fields jsonb not null default '{}'::jsonb,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);
create index pieces_type_idx on pieces (organization_id, piece_type_id, is_active);

-- Um Braço exige um molde BRAÇO; Pilar/Viga exigem LEITO e LATERAL.
-- A validação da combinação completa é transacional na API e será espelhada
-- por trigger no schema público final após a confirmação do desenho.
create table piece_molds (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references pieces(id) on delete cascade,
  mold_catalog_id uuid not null references mold_catalog(id) on delete restrict,
  role text not null check (role in ('BRACO','LEITO','LATERAL')),
  unique (piece_id, role),
  unique (piece_id, mold_catalog_id)
);

create table mold_positions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null check (code in ('P01','P02','P03','P04')),
  status text not null default 'disponivel'
    check (status in ('disponivel','em_preparacao','em_producao','em_manutencao')),
  notes text,
  unique (organization_id, code)
);

create table mold_position_molds (
  id uuid primary key default gen_random_uuid(),
  mold_position_id uuid not null references mold_positions(id) on delete cascade,
  mold_catalog_id uuid not null references mold_catalog(id) on delete restrict,
  role text not null check (role in ('BRACO','LEITO','LATERAL')),
  installed_at timestamptz not null default now(),
  removed_at timestamptz,
  check (removed_at is null or removed_at >= installed_at)
);
create unique index mold_position_current_role_uq
  on mold_position_molds (mold_position_id, role) where removed_at is null;

create table orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  work_id uuid references works(id) on delete set null,
  client_id uuid not null references clients(id) on delete restrict,
  order_number text,
  start_date date not null,
  requested_due_date date,
  -- planned_end_date é a regra linear base; forecast_end_date soma ajustes externos.
  planned_end_date date,
  forecast_end_date date,
  status text not null default 'orcamento'
    check (status in ('orcamento','aprovado','em_producao','concluido','entregue','atrasado','cancelado')),
  notes text,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_due_date is null or requested_due_date >= start_date),
  unique (organization_id, order_number)
);
create index orders_calendar_idx on orders (organization_id, status, start_date, planned_end_date);
create index orders_work_idx on orders (organization_id, work_id);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  piece_id uuid not null references pieces(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  sequence integer not null check (sequence > 0),
  notes text,
  created_at timestamptz not null default now(),
  unique (order_id, sequence)
);
create index order_items_order_idx on order_items (organization_id, order_id, sequence);

create table mold_preparations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  mold_position_id uuid not null references mold_positions(id) on delete restrict,
  preparation_start_date date not null,
  preparation_end_date date not null,
  started_at timestamptz,
  released_at timestamptz,
  setup_minutes integer check (setup_minutes is null or setup_minutes >= 0),
  checklist jsonb not null default '{"limpeza":false,"desmoldante":false,"montagem":false,"inspecao_dimensional":false}'::jsonb,
  status text not null default 'planejada'
    check (status in ('planejada','em_andamento','liberada','reprovada','cancelada')),
  responsible_name text,
  approved_by text,
  notes text,
  created_at timestamptz not null default now(),
  check (preparation_end_date = preparation_start_date + 6),
  check (released_at is null or started_at is null or released_at >= started_at)
);
create index mold_preparations_position_idx
  on mold_preparations (organization_id, mold_position_id, status, started_at);

create function validate_mold_preparation_release()
returns trigger language plpgsql as $$
begin
  if new.status = 'liberada' then
    if new.preparation_end_date > current_date then
      raise exception 'A preparação só pode ser liberada após os sete dias corridos.';
    end if;
    if coalesce((new.checklist->>'limpeza')::boolean, false) is not true
       or coalesce((new.checklist->>'desmoldante')::boolean, false) is not true
       or coalesce((new.checklist->>'montagem')::boolean, false) is not true
       or coalesce((new.checklist->>'inspecao_dimensional')::boolean, false) is not true then
      raise exception 'Conclua o checklist de preparação antes de liberar a posição.';
    end if;
    if nullif(trim(new.approved_by), '') is null or new.released_at is null then
      raise exception 'Informe responsável e data/hora da liberação.';
    end if;
  end if;
  return new;
end;
$$;
create trigger mold_preparation_release_check
  before insert or update on mold_preparations
  for each row execute function validate_mold_preparation_release();

create table production_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lot_code text not null,
  cast_at timestamptz,
  cast_date date,
  responsible_name text,
  status text not null default 'aberto'
    check (status in ('aberto','em_cura','aguardando_inspecao','aprovado','reprovado','encerrado')),
  notes text,
  created_at timestamptz not null default now(),
  unique (organization_id, lot_code)
);

-- Uma linha representa uma unidade física, preservando sequência e rastreio.
create table production_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete restrict,
  unit_sequence integer not null check (unit_sequence > 0),
  production_batch_id uuid references production_batches(id) on delete set null,
  planned_cast_date date,
  planned_cure_start_date date,
  planned_cure_end_date date,
  planned_finish_date date,
  planned_end_date date,
  forecast_end_date date,
  actual_cast_at timestamptz,
  actual_finish_at timestamptz,
  status text not null default 'planejada'
    check (status in ('planejada','liberada','em_concretagem','em_cura','acabamento','concluida','cancelada','refugada')),
  quality_status text check (quality_status in ('liberada','em_reparo','bloqueada')),
  notes text,
  created_at timestamptz not null default now(),
  unique (order_item_id, unit_sequence)
);
create index production_orders_queue_idx
  on production_orders (organization_id, planned_cast_date, order_id, order_item_id, unit_sequence);
create index production_orders_order_idx on production_orders (organization_id, order_id, status);

create table allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete cascade,
  mold_position_id uuid not null references mold_positions(id) on delete restrict,
  scheduled_date date not null,
  assigned_at timestamptz,
  released_at timestamptz,
  assigned_by text,
  released_by text,
  release_reason text,
  status text not null default 'planejada'
    check (status in ('planejada','em_andamento','concluida','cancelada')),
  notes text,
  check (released_at is null or assigned_at is null or released_at >= assigned_at)
);
create unique index allocations_one_active_unit_uq
  on allocations (production_order_id) where status in ('planejada','em_andamento');
create unique index allocations_one_active_position_day_uq
  on allocations (mold_position_id, scheduled_date) where status in ('planejada','em_andamento');
create index allocations_calendar_idx on allocations (organization_id, scheduled_date, mold_position_id, status);

create table materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  unit text not null,
  critical_stock_threshold numeric(18,6) check (critical_stock_threshold is null or critical_stock_threshold >= 0),
  is_active boolean not null default true,
  unique (organization_id, code)
);

create table bom_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  piece_id uuid not null references pieces(id) on delete cascade,
  material_id uuid not null references materials(id) on delete restrict,
  quantity_factor numeric(18,6) not null check (quantity_factor > 0),
  expected_loss_percent numeric(7,4) not null default 0 check (expected_loss_percent >= 0),
  calculation_basis text not null default 'por_unidade'
    check (calculation_basis in ('por_unidade','por_m3','por_kg','formula_pendente')),
  notes text,
  unique (piece_id, material_id)
);

create table material_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete cascade,
  bom_item_id uuid not null references bom_items(id) on delete restrict,
  quantity_reserved numeric(18,6) not null check (quantity_reserved > 0),
  quantity_consumed numeric(18,6) not null default 0 check (quantity_consumed >= 0),
  status text not null default 'reservado'
    check (status in ('reservado','consumido','liberado','parcial')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id, bom_item_id)
);

create table material_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  material_id uuid not null references materials(id) on delete restrict,
  order_id uuid references orders(id) on delete set null,
  production_order_id uuid references production_orders(id) on delete set null,
  movement_type text not null check (movement_type in ('entrada','reserva','baixa','perda','devolucao','ajuste')),
  quantity numeric(18,6) not null check (quantity > 0),
  occurred_at timestamptz not null default now(),
  reason text,
  created_by text
);
create index material_movements_stock_idx
  on material_movements (organization_id, material_id, occurred_at);

create table quality_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  piece_type_id uuid references piece_types(id) on delete restrict,
  standard_reference text,
  minimum_demold_strength_mpa numeric(10,3) check (minimum_demold_strength_mpa is null or minimum_demold_strength_mpa > 0),
  test_age_days smallint check (test_age_days is null or test_age_days > 0),
  valid_from date,
  valid_until date,
  approved_by text,
  notes text,
  check (valid_until is null or valid_from is null or valid_until >= valid_from),
  check (minimum_demold_strength_mpa is null or nullif(trim(standard_reference), '') is not null)
);

create table curing_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete cascade,
  quality_requirement_id uuid references quality_requirements(id) on delete set null,
  cure_started_at timestamptz,
  cure_completed_at timestamptz,
  required_curing_days smallint not null check (required_curing_days > 0),
  measured_demold_strength_mpa numeric(10,3) check (measured_demold_strength_mpa is null or measured_demold_strength_mpa >= 0),
  demold_released_at timestamptz,
  released_by text,
  yard_location_id uuid,
  notes text,
  check (cure_completed_at is null or cure_started_at is null or cure_completed_at >= cure_started_at)
);

create table inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_batch_id uuid not null references production_batches(id) on delete cascade,
  production_order_id uuid references production_orders(id) on delete set null,
  inspected_at timestamptz not null default now(),
  inspector_name text,
  result text not null check (result in ('aprovado','reprovado','retrabalho')),
  test_name text,
  test_method text,
  standard_reference text,
  measured_value numeric(18,6),
  checklist jsonb not null default '{}'::jsonb,
  photo_refs jsonb not null default '[]'::jsonb,
  notes text
);
create index inspections_batch_idx on inspections (organization_id, production_batch_id, inspected_at);

create table rework_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete restrict,
  inspection_id uuid references inspections(id) on delete set null,
  stage_to_repeat text check (stage_to_repeat in ('concretagem','cura','acabamento','inspecao')),
  reason text not null,
  status text not null default 'aberta' check (status in ('aberta','em_andamento','concluida','cancelada')),
  planned_start_date date,
  planned_end_date date,
  actual_end_at timestamptz,
  responsible_name text,
  created_at timestamptz not null default now()
);
-- Nesta fase, retrabalho não reinicia etapas automaticamente. O operador
-- registra o impacto manual em delay_adjustments.

create table scrap_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete restrict,
  production_batch_id uuid references production_batches(id) on delete set null,
  quantity integer not null default 1 check (quantity > 0),
  reason text not null,
  recorded_at timestamptz not null default now(),
  recorded_by text,
  notes text
);

create table yard_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  description text,
  is_active boolean not null default true,
  unique (organization_id, code)
);

alter table curing_records
  add constraint curing_records_yard_location_fk
  foreign key (yard_location_id) references yard_locations(id) on delete set null;

create table finished_goods_inventory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null unique references production_orders(id) on delete restrict,
  yard_location_id uuid references yard_locations(id) on delete set null,
  reserved_order_id uuid references orders(id) on delete set null,
  status text not null default 'em_estoque'
    check (status in ('em_estoque','reservada','expedida','montada','refugada')),
  entered_at timestamptz,
  updated_at timestamptz not null default now()
);

create table finished_goods_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete restrict,
  from_location_id uuid references yard_locations(id) on delete set null,
  to_location_id uuid references yard_locations(id) on delete set null,
  movement_type text not null check (movement_type in ('entrada','transferencia','reserva','expedicao','montagem','refugo')),
  occurred_at timestamptz not null default now(),
  responsible_name text,
  notes text
);

create table shipments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete restrict,
  work_id uuid references works(id) on delete set null,
  vehicle text,
  responsible_name text,
  destination text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  status text not null default 'planejada'
    check (status in ('planejada','carregada','expedida','entregue','cancelada')),
  notes text,
  check (delivered_at is null or shipped_at is null or delivered_at >= shipped_at)
);

create table shipment_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete restrict,
  quantity integer not null default 1 check (quantity = 1),
  unique (shipment_id, production_order_id)
);

create table assembly_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete restrict,
  work_id uuid not null references works(id) on delete restrict,
  assembled_at timestamptz,
  responsible_name text,
  status text not null default 'pendente' check (status in ('pendente','em_andamento','concluida','com_pendencia')),
  pending_items jsonb not null default '[]'::jsonb,
  notes text
);

create table delay_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  production_order_id uuid references production_orders(id) on delete set null,
  reason text not null,
  occurred_on date not null,
  impact_days integer not null check (impact_days <> 0),
  applied_to_forecast boolean not null default true,
  previous_forecast_end date,
  adjusted_forecast_end date,
  recorded_by text,
  created_at timestamptz not null default now()
);

create table kpi_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  captured_at timestamptz not null default now(),
  period_start date not null,
  period_end date not null,
  filters jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  check (period_end >= period_start)
);
create index kpi_snapshots_period_idx on kpi_snapshots (organization_id, period_start, period_end, captured_at desc);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity_name text not null,
  entity_id uuid,
  action text not null,
  actor_id uuid,
  actor_label text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index order_items_piece_idx on order_items (organization_id, piece_id);
create index mold_position_molds_catalog_idx on mold_position_molds (mold_catalog_id, mold_position_id);
create index curing_records_unit_idx on curing_records (organization_id, production_order_id);
create index rework_orders_unit_status_idx on rework_orders (organization_id, production_order_id, status);
create index scrap_records_unit_idx on scrap_records (organization_id, production_order_id, recorded_at);
create index finished_goods_inventory_status_idx
  on finished_goods_inventory (organization_id, status, yard_location_id);
create index finished_goods_movements_unit_idx
  on finished_goods_movements (organization_id, production_order_id, occurred_at);
create index shipments_order_status_idx on shipments (organization_id, order_id, status);
create index shipment_items_unit_idx on shipment_items (organization_id, production_order_id);
create index delay_adjustments_order_idx
  on delay_adjustments (organization_id, order_id, occurred_on);
create index audit_logs_entity_idx on audit_logs (organization_id, entity_name, entity_id, created_at desc);

create function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger calendar_settings_updated_at before update on calendar_settings
  for each row execute function set_updated_at();
create trigger clients_updated_at before update on clients
  for each row execute function set_updated_at();
create trigger works_updated_at before update on works
  for each row execute function set_updated_at();
create trigger pieces_updated_at before update on pieces
  for each row execute function set_updated_at();
create trigger orders_updated_at before update on orders
  for each row execute function set_updated_at();
create trigger material_reservations_updated_at before update on material_reservations
  for each row execute function set_updated_at();
create trigger finished_goods_inventory_updated_at before update on finished_goods_inventory
  for each row execute function set_updated_at();

-- A resistência mínima não é usada para bloquear a desforma nesta fase,
-- conforme decisão do usuário. Os campos opcionais ficam preparados para
-- um critério técnico futuro.

-- Seeds dos catálogos fixos solicitados. Em produção, estas tabelas serão de
-- leitura para o operador; alterações serão controladas por migração versionada.
insert into piece_types (code, name) values
  ('BRACO','Braço'), ('PILAR','Pilar'), ('VIGA','Viga');

insert into mold_catalog (mold_type, dimension_x_cm, dimension_y_cm, measure_label) values
  ('LEITO',20,null,'20'), ('LEITO',25,null,'25'), ('LEITO',30,null,'30'),
  ('LEITO',35,null,'35'), ('LEITO',40,null,'40'), ('LEITO',50,null,'50'), ('LEITO',60,null,'60'),
  ('LATERAL',25,null,'25'), ('LATERAL',30,null,'30'), ('LATERAL',40,null,'40'),
  ('LATERAL',50,null,'50'), ('LATERAL',60,null,'60'),
  ('BRACO',25,35,'25x35'), ('BRACO',25,52,'25x52'), ('BRACO',30,60,'30x60');

-- Schema de proposta não é exposto ao navegador. No schema público final,
-- manter RLS habilitado e sem policies públicas; o acesso passa por validação
-- no servidor. A chave service_role nunca deve chegar ao cliente.
do $$
declare t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'prelux_stage1_proposal'
  loop
    execute format('alter table prelux_stage1_proposal.%I enable row level security', t.tablename);
  end loop;
end $$;

-- Não há seed de resistência mínima, tempo de setup nem fórmula de consumo de materiais.
-- PREMISSA: até informar a duração do setup, ela fica registrada como NULL e não
-- desloca o planejamento automático. A preparação permanece em sete dias,
-- confirmada pelo usuário com base no comportamento do banco atual.
