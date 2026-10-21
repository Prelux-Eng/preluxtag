-- PRELUX · modelo inicial de planejamento, produção, pedidos e estoque
-- Banco alvo: PostgreSQL/Supabase

create extension if not exists pgcrypto;

do $$ begin
  create type public.order_status as enum (
    'orcamento', 'aprovado', 'em_producao', 'concluido',
    'entregue', 'atrasado', 'cancelado'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.calendar_exception_kind as enum (
    'feriado', 'dia_extra', 'parada', 'manutencao', 'folga_coletiva', 'personalizada'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.production_schedule_status as enum (
    'planned', 'in_progress', 'done', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.stock_movement_type as enum (
    'entrada', 'saida', 'producao', 'ajuste'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.stock_reservation_status as enum (
    'reserved', 'consumed', 'released'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'America/Sao_Paulo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  default_capacity_minutes integer not null default 480 check (default_capacity_minutes >= 0),
  planning_horizon_days integer not null default 365 check (planning_horizon_days between 1 and 730),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_working_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  is_working boolean not null default true,
  capacity_minutes integer not null default 480 check (capacity_minutes >= 0),
  unique (organization_id, weekday)
);

create table if not exists public.calendar_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  kind public.calendar_exception_kind not null default 'personalizada',
  start_date date not null,
  end_date date not null,
  is_working boolean not null default false,
  capacity_minutes integer check (capacity_minutes is null or capacity_minutes >= 0),
  priority smallint not null default 0,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table if not exists public.calendar_days (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  date date not null,
  is_working boolean not null default false,
  capacity_minutes integer not null default 0 check (capacity_minutes >= 0),
  source text not null default 'regra' check (source in ('regra', 'excecao', 'manual')),
  exception_id uuid references public.calendar_exceptions(id) on delete set null,
  note text,
  generated_at timestamptz not null default now(),
  primary key (organization_id, date)
);

create table if not exists public.piece_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.piece_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid references public.piece_categories(id) on delete set null,
  code text not null,
  name text not null,
  dimensions text not null default '',
  weight_kg numeric(12, 3) check (weight_kg is null or weight_kg >= 0),
  production_minutes_per_unit integer not null check (production_minutes_per_unit > 0),
  initial_stock_quantity integer not null default 0 check (initial_stock_quantity >= 0),
  stock_minimum_quantity integer not null default 0 check (stock_minimum_quantity >= 0),
  observations text,
  custom_fields jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_name text not null check (entity_name in ('piece_type', 'client', 'order')),
  field_key text not null,
  label text not null,
  field_type text not null check (field_type in ('text', 'number', 'date', 'boolean', 'select')),
  options jsonb not null default '[]'::jsonb,
  is_required boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, entity_name, field_key)
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  document text,
  contact_name text,
  phone text,
  email text,
  address text,
  observations text,
  custom_fields jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_number text,
  client_id uuid not null references public.clients(id) on delete restrict,
  start_date date not null default current_date,
  requested_due_date date,
  planned_end_date date,
  status public.order_status not null default 'orcamento',
  observations text,
  custom_fields jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_due_date is null or requested_due_date >= start_date)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  production_minutes_snapshot integer not null check (production_minutes_snapshot > 0),
  sequence smallint not null default 1 check (sequence > 0),
  observations text,
  created_at timestamptz not null default now(),
  unique (order_id, sequence)
);

create table if not exists public.production_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete restrict,
  work_date date not null,
  planned_quantity integer not null check (planned_quantity > 0),
  planned_minutes integer not null check (planned_minutes > 0),
  actual_quantity integer not null default 0 check (actual_quantity >= 0),
  status public.production_schedule_status not null default 'planned',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id, work_date)
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete restrict,
  movement_type public.stock_movement_type not null,
  quantity integer not null check (quantity > 0),
  order_id uuid references public.orders(id) on delete set null,
  occurred_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status public.stock_reservation_status not null default 'reserved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id)
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_name text not null,
  entity_id uuid,
  action text not null,
  actor_label text not null default 'acesso-publico',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_calendar_exceptions_period
  on public.calendar_exceptions (organization_id, start_date, end_date)
  where is_active = true;
create index if not exists idx_calendar_days_working
  on public.calendar_days (organization_id, date, is_working);
create index if not exists idx_piece_types_active
  on public.piece_types (organization_id, is_active, code);
create index if not exists idx_clients_active
  on public.clients (organization_id, is_active, name);
create index if not exists idx_orders_planning
  on public.orders (organization_id, status, start_date, requested_due_date)
  where is_active = true;
create index if not exists idx_order_items_order
  on public.order_items (organization_id, order_id, sequence);
create index if not exists idx_production_schedules_day
  on public.production_schedules (organization_id, work_date, status);
create index if not exists idx_stock_movements_piece_date
  on public.stock_movements (organization_id, piece_type_id, occurred_at);
create index if not exists idx_stock_reservations_piece_status
  on public.stock_reservations (organization_id, piece_type_id, status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations', 'calendar_settings', 'calendar_exceptions', 'piece_categories',
    'piece_types', 'clients', 'orders', 'production_schedules', 'stock_reservations'
  ] loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', table_name, table_name);
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      table_name, table_name
    );
  end loop;
end $$;

create or replace view public.v_stock_balances as
select
  pt.organization_id,
  pt.id as piece_type_id,
  pt.initial_stock_quantity
    + coalesce(sum(
      case
        when sm.movement_type in ('entrada', 'producao', 'ajuste') then sm.quantity
        when sm.movement_type = 'saida' then -sm.quantity
        else 0
      end
    ), 0)::integer as stock_quantity
from public.piece_types pt
left join public.stock_movements sm
  on sm.organization_id = pt.organization_id
 and sm.piece_type_id = pt.id
group by pt.organization_id, pt.id, pt.initial_stock_quantity;

create or replace view public.v_stock_reservations as
select
  organization_id,
  piece_type_id,
  coalesce(sum(quantity) filter (where status = 'reserved'), 0)::integer as reserved_quantity
from public.stock_reservations
group by organization_id, piece_type_id;

create or replace view public.v_piece_inventory as
select
  pt.organization_id,
  pt.id as piece_type_id,
  pt.code,
  pt.name,
  pc.name as category,
  pt.stock_minimum_quantity,
  coalesce(sb.stock_quantity, 0)::integer as stock_quantity,
  coalesce(sr.reserved_quantity, 0)::integer as reserved_quantity,
  greatest(coalesce(sb.stock_quantity, 0) - coalesce(sr.reserved_quantity, 0), 0)::integer
    as available_stock_quantity,
  coalesce(prod.quantity_in_production, 0)::integer as quantity_in_production,
  (
    greatest(coalesce(sb.stock_quantity, 0) - coalesce(sr.reserved_quantity, 0), 0)
    < pt.stock_minimum_quantity
  ) as is_below_minimum
from public.piece_types pt
left join public.piece_categories pc on pc.id = pt.category_id
left join public.v_stock_balances sb
  on sb.organization_id = pt.organization_id and sb.piece_type_id = pt.id
left join public.v_stock_reservations sr
  on sr.organization_id = pt.organization_id and sr.piece_type_id = pt.id
left join lateral (
  select coalesce(sum(greatest(ps.planned_quantity - ps.actual_quantity, 0)), 0) as quantity_in_production
  from public.production_schedules ps
  where ps.organization_id = pt.organization_id
    and ps.piece_type_id = pt.id
    and ps.status in ('planned', 'in_progress')
) prod on true
where pt.is_active = true;

create or replace view public.v_capacity_daily as
select
  cd.organization_id,
  cd.date,
  cd.is_working,
  cd.capacity_minutes,
  coalesce(sum(ps.planned_minutes) filter (where ps.status <> 'cancelled'), 0)::integer
    as planned_minutes,
  coalesce(sum(ps.actual_quantity), 0)::integer as actual_quantity,
  case
    when cd.capacity_minutes > 0 then round(
      coalesce(sum(ps.planned_minutes) filter (where ps.status <> 'cancelled'), 0)::numeric
      / cd.capacity_minutes * 100, 2
    )
    else 0
  end as occupancy_percent
from public.calendar_days cd
left join public.production_schedules ps
  on ps.organization_id = cd.organization_id and ps.work_date = cd.date
group by cd.organization_id, cd.date, cd.is_working, cd.capacity_minutes;

create or replace view public.v_order_progress as
select
  o.organization_id,
  o.id as order_id,
  o.order_number,
  o.client_id,
  o.start_date,
  o.requested_due_date,
  o.planned_end_date,
  o.status,
  coalesce(items.requested_quantity, 0)::integer as requested_quantity,
  coalesce(schedule.planned_quantity, 0)::integer as planned_quantity,
  coalesce(schedule.actual_quantity, 0)::integer as actual_quantity,
  case
    when coalesce(items.requested_quantity, 0) = 0 then 0
    else round(coalesce(schedule.actual_quantity, 0)::numeric / items.requested_quantity * 100, 2)
  end as completion_percent
from public.orders o
left join lateral (
  select sum(oi.quantity) as requested_quantity
  from public.order_items oi
  where oi.order_id = o.id
) items on true
left join lateral (
  select
    sum(ps.planned_quantity) filter (where ps.status <> 'cancelled') as planned_quantity,
    sum(ps.actual_quantity) as actual_quantity
  from public.production_schedules ps
  where ps.order_id = o.id
) schedule on true
where o.is_active = true;

-- Acesso público só passa pelas Edge Functions. Com RLS ativo e sem policies
-- públicas, o navegador não pode consultar ou alterar as tabelas diretamente.
alter table public.organizations enable row level security;
alter table public.calendar_settings enable row level security;
alter table public.calendar_working_rules enable row level security;
alter table public.calendar_exceptions enable row level security;
alter table public.calendar_days enable row level security;
alter table public.piece_categories enable row level security;
alter table public.piece_types enable row level security;
alter table public.custom_field_definitions enable row level security;
alter table public.clients enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.production_schedules enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.audit_logs enable row level security;

-- Unidade inicial PRELUX. O ID também é usado em PRELUX_ORGANIZATION_ID.
insert into public.organizations (id, name, slug)
values ('11111111-1111-4111-8111-111111111111', 'PRELUX Estruturas Pré-Moldadas', 'prelux')
on conflict (id) do update set name = excluded.name, slug = excluded.slug;

insert into public.calendar_settings (organization_id, default_capacity_minutes, planning_horizon_days)
values ('11111111-1111-4111-8111-111111111111', 480, 365)
on conflict (organization_id) do nothing;

insert into public.calendar_working_rules (organization_id, weekday, is_working, capacity_minutes)
select '11111111-1111-4111-8111-111111111111', days.day_number, days.day_number between 1 and 5, 480
from generate_series(0, 6) as days(day_number)
on conflict (organization_id, weekday) do nothing;
