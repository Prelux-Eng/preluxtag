-- PRELUX · obras, catálogo de peças, moldes e alocação de recursos

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  work_number text,
  name text not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  address text,
  responsible_name text,
  start_date date,
  requested_due_date date,
  status text not null default 'planejamento'
    check (status in ('planejamento', 'ativa', 'concluida', 'cancelada')),
  observations text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_due_date is null or start_date is null or requested_due_date >= start_date)
);

create unique index if not exists idx_works_number
  on public.works (organization_id, work_number)
  where work_number is not null and work_number <> '';
create index if not exists idx_works_active on public.works (organization_id, is_active, name);

alter table public.orders
  add column if not exists work_id uuid references public.works(id) on delete set null;
create index if not exists idx_orders_work on public.orders (organization_id, work_id);

alter table public.piece_types
  add column if not exists volume_m3 numeric(12, 6) check (volume_m3 is null or volume_m3 >= 0),
  add column if not exists reinforcement_spec text,
  add column if not exists curing_days integer check (curing_days is null or curing_days >= 0);

create table if not exists public.molds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  mold_type text not null default 'personalizado',
  dimensions text not null default '',
  cycle_minutes_per_unit integer not null check (cycle_minutes_per_unit > 0),
  preparation_days smallint not null default 7 check (preparation_days = 7),
  status text not null default 'ativo'
    check (status in ('ativo', 'manutencao', 'bloqueado', 'retirado')),
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists idx_molds_active on public.molds (organization_id, status, code);

create table if not exists public.mold_piece_types (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mold_id uuid not null references public.molds(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (mold_id, piece_type_id)
);
create index if not exists idx_mold_piece_types_piece
  on public.mold_piece_types (organization_id, piece_type_id);

create table if not exists public.mold_preparations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mold_id uuid not null references public.molds(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  status text not null default 'planejada'
    check (status in ('planejada', 'em_andamento', 'aguardando_aprovacao', 'aprovada', 'reprovada', 'cancelada')),
  checklist jsonb not null default '{"limpeza": false, "desmoldante": false, "montagem": false}'::jsonb,
  approved_by text,
  approved_at timestamptz,
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date = start_date + 6)
);
create index if not exists idx_mold_preparations_period
  on public.mold_preparations (organization_id, mold_id, start_date, end_date);

create table if not exists public.resource_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resource_kind text not null check (resource_kind in ('mold', 'other')),
  mold_id uuid references public.molds(id) on delete restrict,
  resource_name text not null,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'done', 'cancelled')),
  conflict_reason text,
  conflict_responsible text,
  observations text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check ((resource_kind = 'mold' and mold_id is not null) or (resource_kind = 'other' and mold_id is null))
);
create index if not exists idx_resource_allocations_mold_period
  on public.resource_allocations (organization_id, mold_id, start_date, end_date)
  where resource_kind = 'mold' and status <> 'cancelled';
create index if not exists idx_resource_allocations_other_period
  on public.resource_allocations (organization_id, lower(resource_name), start_date, end_date)
  where resource_kind = 'other' and status <> 'cancelled';

drop trigger if exists trg_works_updated_at on public.works;
create trigger trg_works_updated_at before update on public.works
  for each row execute function public.set_updated_at();
drop trigger if exists trg_molds_updated_at on public.molds;
create trigger trg_molds_updated_at before update on public.molds
  for each row execute function public.set_updated_at();
drop trigger if exists trg_mold_preparations_updated_at on public.mold_preparations;
create trigger trg_mold_preparations_updated_at before update on public.mold_preparations
  for each row execute function public.set_updated_at();
drop trigger if exists trg_resource_allocations_updated_at on public.resource_allocations;
create trigger trg_resource_allocations_updated_at before update on public.resource_allocations
  for each row execute function public.set_updated_at();

create or replace function public.validate_mold_preparation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.end_date <> new.start_date + 6 then
    raise exception 'A preparação do molde precisa ocupar sete dias corridos.';
  end if;

  if not exists (
    select 1 from public.molds
    where id = new.mold_id and organization_id = new.organization_id and status <> 'retirado'
  ) then
    raise exception 'Molde não encontrado ou retirado nesta unidade.';
  end if;

  if new.status = 'aprovada' then
    if new.end_date > current_date then
      raise exception 'A preparação só pode ser aprovada depois dos sete dias corridos.';
    end if;
    if coalesce((new.checklist->>'limpeza')::boolean, false) is not true
      or coalesce((new.checklist->>'desmoldante')::boolean, false) is not true
      or coalesce((new.checklist->>'montagem')::boolean, false) is not true then
      raise exception 'Conclua limpeza, desmoldante e montagem antes de aprovar o molde.';
    end if;
    if nullif(trim(new.approved_by), '') is null then
      raise exception 'Informe quem aprovou a preparação do molde.';
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
      raise exception 'O molde já tem outra preparação neste período.';
    end if;
    if exists (
      select 1 from public.resource_allocations a
      where a.organization_id = new.organization_id
        and a.resource_kind = 'mold'
        and a.mold_id = new.mold_id
        and a.status <> 'cancelled'
        and a.start_date <= new.end_date and a.end_date >= new.start_date
    ) then
      raise exception 'O molde está alocado à produção durante este período.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_mold_preparation on public.mold_preparations;
create trigger trg_validate_mold_preparation
  before insert or update on public.mold_preparations
  for each row execute function public.validate_mold_preparation();

create or replace function public.validate_resource_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_piece_type_id uuid;
  v_mold_code text;
  v_last_use_end date;
  v_has_prep boolean;
begin
  if new.end_date < new.start_date then
    raise exception 'A data final não pode ser anterior à data inicial.';
  end if;
  if not exists (
    select 1 from public.order_items oi
    where oi.id = new.order_item_id and oi.organization_id = new.organization_id
  ) then
    raise exception 'O item de produção não pertence a esta unidade.';
  end if;
  if new.status in ('planned', 'in_progress') and exists (
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
    where oi.id = new.order_item_id and oi.organization_id = new.organization_id
      and o.status in ('concluido', 'entregue', 'cancelado')
  ) then
    raise exception 'Pedidos concluídos, entregues ou cancelados não aceitam novas alocações.';
  end if;
  if new.resource_kind = 'mold' and not exists (
    select 1 from public.molds m where m.id = new.mold_id and m.organization_id = new.organization_id
  ) then
    raise exception 'Molde não encontrado nesta unidade.';
  end if;
  if new.resource_kind = 'other' and new.mold_id is not null then
    raise exception 'Recurso auxiliar não pode apontar para um molde.';
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  if new.resource_kind = 'mold' then
    if new.mold_id is null then raise exception 'Selecione um molde.'; end if;
    select code into v_mold_code from public.molds
    where id = new.mold_id and organization_id = new.organization_id and status = 'ativo';
    if v_mold_code is null then raise exception 'Molde não encontrado ou indisponível.'; end if;
    new.resource_name := v_mold_code;

    perform pg_advisory_xact_lock(hashtext(new.organization_id::text || ':mold:' || new.mold_id::text)::bigint);
    if exists (
      select 1 from public.resource_allocations a
      where a.organization_id = new.organization_id
        and a.resource_kind = 'mold'
        and a.mold_id = new.mold_id
        and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
        and a.status <> 'cancelled'
        and a.start_date <= new.end_date and a.end_date >= new.start_date
    ) then
      raise exception 'O molde já está ocupado neste período.';
    end if;
    if exists (
      select 1 from public.mold_preparations p
      where p.organization_id = new.organization_id
        and p.mold_id = new.mold_id
        and p.status <> 'cancelada'
        and p.start_date <= new.end_date and p.end_date >= new.start_date
    ) then
      raise exception 'O molde está em preparação durante este período.';
    end if;

    select piece_type_id into v_piece_type_id from public.order_items
    where id = new.order_item_id and organization_id = new.organization_id;
    if not exists (
      select 1 from public.mold_piece_types
      where organization_id = new.organization_id
        and mold_id = new.mold_id and piece_type_id = v_piece_type_id
    ) then
      raise exception 'O molde não está cadastrado para fabricar este tipo de peça.';
    end if;

    select max(end_date) into v_last_use_end from public.resource_allocations a
    where a.organization_id = new.organization_id
      and a.resource_kind = 'mold' and a.mold_id = new.mold_id
      and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and a.status <> 'cancelled' and a.end_date < new.start_date;
    select exists (
      select 1 from public.mold_preparations p
      where p.organization_id = new.organization_id
        and p.mold_id = new.mold_id
        and p.status = 'aprovada'
        and p.end_date < new.start_date
        and (v_last_use_end is null or p.end_date >= v_last_use_end)
    ) into v_has_prep;
    if not v_has_prep then
      raise exception 'A produção exige preparação aprovada do molde depois do último uso.';
    end if;
  else
    if new.mold_id is not null then raise exception 'Recurso auxiliar não pode apontar para um molde.'; end if;
    new.resource_name := nullif(trim(new.resource_name), '');
    if new.resource_name is null then raise exception 'Informe o nome do outro recurso.'; end if;
    perform pg_advisory_xact_lock(hashtext(new.organization_id::text || ':other:' || lower(new.resource_name))::bigint);
    if exists (
      select 1 from public.resource_allocations a
      where a.organization_id = new.organization_id
        and a.resource_kind = 'other'
        and lower(a.resource_name) = lower(new.resource_name)
        and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
        and a.status <> 'cancelled'
        and a.start_date <= new.end_date and a.end_date >= new.start_date
    ) and (nullif(trim(new.conflict_reason), '') is null or nullif(trim(new.conflict_responsible), '') is null) then
      raise exception 'Conflito com outro recurso: registre a justificativa e o responsável para manter a alocação.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_resource_allocation on public.resource_allocations;
create trigger trg_validate_resource_allocation
  before insert or update on public.resource_allocations
  for each row execute function public.validate_resource_allocation();

create or replace function public.save_work_record(p_org_id uuid, p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_client_id uuid := nullif(p_record->>'clientId', '')::uuid;
  v_row public.works;
  v_name text := nullif(trim(p_record->>'name'), '');
begin
  if v_name is null or v_client_id is null then raise exception 'Informe o nome da obra e o cliente.'; end if;
  if not exists (select 1 from public.clients where id = v_client_id and organization_id = p_org_id and is_active) then
    raise exception 'Cliente não encontrado nesta unidade.';
  end if;
  if nullif(p_record->>'requestedDueDate', '') is not null
    and nullif(p_record->>'startDate', '') is not null
    and (p_record->>'requestedDueDate')::date < (p_record->>'startDate')::date then
    raise exception 'O prazo da obra não pode ser anterior ao início.';
  end if;
  if v_id is not null then
    if exists (
      select 1 from public.orders
      where organization_id = p_org_id and work_id = v_id and client_id <> v_client_id
    ) then
      raise exception 'A obra já tem pedidos vinculados; o cliente não pode ser alterado.';
    end if;
    update public.works set
      work_number = nullif(trim(p_record->>'workNumber'), ''),
      name = v_name,
      client_id = v_client_id,
      address = nullif(trim(p_record->>'address'), ''),
      responsible_name = nullif(trim(p_record->>'responsibleName'), ''),
      start_date = nullif(p_record->>'startDate', '')::date,
      requested_due_date = nullif(p_record->>'requestedDueDate', '')::date,
      status = coalesce(nullif(p_record->>'status', ''), 'planejamento'),
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Obra não encontrada.'; end if;
  else
    insert into public.works (
      organization_id, work_number, name, client_id, address, responsible_name,
      start_date, requested_due_date, status, observations
    ) values (
      p_org_id, nullif(trim(p_record->>'workNumber'), ''), v_name, v_client_id,
      nullif(trim(p_record->>'address'), ''), nullif(trim(p_record->>'responsibleName'), ''),
      nullif(p_record->>'startDate', '')::date, nullif(p_record->>'requestedDueDate', '')::date,
      coalesce(nullif(p_record->>'status', ''), 'planejamento'), nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.save_order_with_items(p_org_id uuid, p_order jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_order->>'id', '')::uuid;
  v_work_id uuid := nullif(p_order->>'workId', '')::uuid;
  v_client_id uuid := nullif(p_order->>'clientId', '')::uuid;
  v_work_client_id uuid;
  v_start_date date := coalesce(nullif(p_order->>'startDate', '')::date, current_date);
  v_due_date date := nullif(p_order->>'requestedDueDate', '')::date;
  v_status public.order_status := coalesce(nullif(p_order->>'status', ''), 'orcamento')::public.order_status;
  v_order public.orders;
  v_item jsonb;
  v_piece_type_id uuid;
  v_quantity integer;
  v_minutes integer;
  v_sequence integer := 0;
  v_count integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'O pedido precisa ter uma lista de itens.';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'O pedido precisa ter entre 1 e 100 itens.';
  end if;
  if v_due_date is not null and v_due_date < v_start_date then
    raise exception 'O prazo solicitado não pode ser anterior ao início.';
  end if;
  if v_work_id is not null then
    select client_id into v_work_client_id from public.works
    where id = v_work_id and organization_id = p_org_id and is_active;
    if v_work_client_id is null then raise exception 'Obra não encontrada ou inativa.'; end if;
    v_client_id := v_work_client_id;
  end if;
  if v_client_id is null or not exists (
    select 1 from public.clients where id = v_client_id and organization_id = p_org_id and is_active
  ) then raise exception 'Selecione um cliente ativo.'; end if;

  if v_id is not null then
    if not exists (select 1 from public.orders where id = v_id and organization_id = p_org_id and is_active) then
      raise exception 'Pedido não encontrado.';
    end if;
    if exists (
      select 1 from public.production_schedules
      where organization_id = p_org_id and order_id = v_id and status in ('in_progress', 'done')
    ) then
      raise exception 'Pedido com produção iniciada ou concluída não pode ser alterado neste cadastro.';
    end if;
    if exists (
      select 1 from public.resource_allocations a
      join public.order_items oi on oi.id = a.order_item_id
      where a.organization_id = p_org_id and oi.order_id = v_id
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
    where id = v_id and organization_id = p_org_id
    returning * into v_order;
    delete from public.production_schedules where organization_id = p_org_id and order_id = v_id and status = 'planned';
    update public.stock_reservations set status = 'released', updated_at = now()
      where organization_id = p_org_id and order_id = v_id and status = 'reserved';
    delete from public.order_items where organization_id = p_org_id and order_id = v_id;
  else
    insert into public.orders (
      organization_id, order_number, work_id, client_id, start_date,
      requested_due_date, status, observations
    ) values (
      p_org_id, nullif(trim(p_order->>'orderNumber'), ''), v_work_id, v_client_id,
      v_start_date, v_due_date, v_status, nullif(trim(p_order->>'observations'), '')
    ) returning * into v_order;
    v_id := v_order.id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_sequence := v_sequence + 1;
    v_piece_type_id := nullif(v_item->>'pieceTypeId', '')::uuid;
    v_quantity := nullif(v_item->>'quantity', '')::integer;
    if v_piece_type_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'Cada item precisa de um tipo de peça e uma quantidade válida.';
    end if;
    select production_minutes_per_unit into v_minutes from public.piece_types
    where id = v_piece_type_id and organization_id = p_org_id and is_active;
    if v_minutes is null then raise exception 'Tipo de peça não encontrado ou inativo.'; end if;
    insert into public.order_items (
      organization_id, order_id, piece_type_id, quantity, production_minutes_snapshot, sequence, observations
    ) values (
      p_org_id, v_id, v_piece_type_id, v_quantity, v_minutes, v_sequence,
      nullif(trim(v_item->>'observations'), '')
    );
    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (p_org_id, 'orders', v_id, case when v_count > 0 then 'saved_with_items' else 'saved' end, 'acesso-publico', p_order);
  return to_jsonb(v_order);
end;
$$;

create or replace function public.save_piece_type(p_org_id uuid, p_record jsonb, p_mold_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_code text := upper(nullif(trim(p_record->>'code'), ''));
  v_name text := nullif(trim(p_record->>'name'), '');
  v_row public.piece_types;
  v_expected integer := coalesce(cardinality(p_mold_ids), 0);
  v_valid integer;
begin
  if v_code is null or v_name is null then raise exception 'Informe código e nome da peça.'; end if;
  if coalesce(nullif(p_record->>'productionMinutesPerUnit', '')::integer, 0) <= 0 then
    raise exception 'O tempo de produção por unidade precisa ser maior que zero.';
  end if;
  select count(distinct selected.mold_id)::integer into v_valid
    from unnest(coalesce(p_mold_ids, '{}'::uuid[])) as selected(mold_id)
    join public.molds m on m.id = selected.mold_id and m.organization_id = p_org_id;
  if v_valid <> v_expected then raise exception 'Uma ou mais compatibilidades de molde são inválidas.'; end if;

  if v_id is not null then
    if exists (
      select 1 from public.resource_allocations a
      join public.order_items oi on oi.id = a.order_item_id
      where a.organization_id = p_org_id and a.resource_kind = 'mold'
        and a.status in ('planned', 'in_progress') and oi.piece_type_id = v_id
        and not (a.mold_id = any(coalesce(p_mold_ids, '{}'::uuid[])))
    ) then
      raise exception 'A compatibilidade não pode remover um molde usado por uma produção planejada.';
    end if;
    update public.piece_types set
      code = v_code, name = v_name, dimensions = coalesce(p_record->>'dimensions', ''),
      weight_kg = nullif(p_record->>'weightKg', '')::numeric,
      volume_m3 = nullif(p_record->>'volumeM3', '')::numeric,
      reinforcement_spec = nullif(trim(p_record->>'reinforcementSpec'), ''),
      production_minutes_per_unit = (p_record->>'productionMinutesPerUnit')::integer,
      curing_days = nullif(p_record->>'curingDays', '')::integer,
      initial_stock_quantity = coalesce(nullif(p_record->>'initialStockQuantity', '')::integer, 0),
      stock_minimum_quantity = coalesce(nullif(p_record->>'stockMinimumQuantity', '')::integer, 0),
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Tipo de peça não encontrado.'; end if;
  else
    insert into public.piece_types (
      organization_id, code, name, dimensions, weight_kg, volume_m3, reinforcement_spec,
      production_minutes_per_unit, curing_days, initial_stock_quantity, stock_minimum_quantity, observations
    ) values (
      p_org_id, v_code, v_name, coalesce(p_record->>'dimensions', ''),
      nullif(p_record->>'weightKg', '')::numeric, nullif(p_record->>'volumeM3', '')::numeric,
      nullif(trim(p_record->>'reinforcementSpec'), ''), (p_record->>'productionMinutesPerUnit')::integer,
      nullif(p_record->>'curingDays', '')::integer,
      coalesce(nullif(p_record->>'initialStockQuantity', '')::integer, 0),
      coalesce(nullif(p_record->>'stockMinimumQuantity', '')::integer, 0),
      nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
    v_id := v_row.id;
  end if;

  delete from public.mold_piece_types where organization_id = p_org_id and piece_type_id = v_id;
  insert into public.mold_piece_types (organization_id, mold_id, piece_type_id)
    select p_org_id, selected.mold_id, v_id
    from unnest(coalesce(p_mold_ids, '{}'::uuid[])) as selected(mold_id);
  return to_jsonb(v_row);
end;
$$;

create or replace function public.save_mold(p_org_id uuid, p_record jsonb, p_piece_type_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_code text := upper(nullif(trim(p_record->>'code'), ''));
  v_name text := nullif(trim(p_record->>'name'), '');
  v_status text := coalesce(nullif(p_record->>'status', ''), 'ativo');
  v_row public.molds;
  v_expected integer := coalesce(cardinality(p_piece_type_ids), 0);
  v_valid integer;
begin
  if v_code is null or v_name is null then raise exception 'Informe código e nome do molde.'; end if;
  if coalesce(nullif(p_record->>'cycleMinutesPerUnit', '')::integer, 0) <= 0 then
    raise exception 'O ciclo do molde precisa ser maior que zero.';
  end if;
  select count(distinct selected.piece_type_id)::integer into v_valid
    from unnest(coalesce(p_piece_type_ids, '{}'::uuid[])) as selected(piece_type_id)
    join public.piece_types p on p.id = selected.piece_type_id and p.organization_id = p_org_id;
  if v_valid <> v_expected then raise exception 'Uma ou mais peças compatíveis são inválidas.'; end if;

  if v_id is not null then
    if v_status <> 'ativo' and exists (
      select 1 from public.resource_allocations
      where organization_id = p_org_id and mold_id = v_id and status in ('planned', 'in_progress')
    ) then
      raise exception 'Cancele as alocações planejadas ou em andamento antes de bloquear o molde.';
    end if;
    if v_status = 'retirado' and exists (
      select 1 from public.mold_preparations
      where organization_id = p_org_id and mold_id = v_id
        and status in ('planejada', 'em_andamento', 'aguardando_aprovacao')
    ) then
      raise exception 'Conclua ou cancele as preparações pendentes antes de retirar o molde.';
    end if;
    if exists (
      select 1 from public.resource_allocations a
      join public.order_items oi on oi.id = a.order_item_id
      where a.organization_id = p_org_id and a.resource_kind = 'mold' and a.mold_id = v_id
        and a.status in ('planned', 'in_progress')
        and not (oi.piece_type_id = any(coalesce(p_piece_type_ids, '{}'::uuid[])))
    ) then
      raise exception 'A compatibilidade não pode remover uma peça usada por uma produção planejada.';
    end if;
    update public.molds set
      code = v_code, name = v_name, mold_type = coalesce(nullif(trim(p_record->>'moldType'), ''), 'personalizado'),
      dimensions = coalesce(p_record->>'dimensions', ''),
      cycle_minutes_per_unit = (p_record->>'cycleMinutesPerUnit')::integer,
      status = v_status,
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Molde não encontrado.'; end if;
  else
    insert into public.molds (
      organization_id, code, name, mold_type, dimensions, cycle_minutes_per_unit, status, observations
    ) values (
      p_org_id, v_code, v_name, coalesce(nullif(trim(p_record->>'moldType'), ''), 'personalizado'),
      coalesce(p_record->>'dimensions', ''), (p_record->>'cycleMinutesPerUnit')::integer,
      v_status, nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
    v_id := v_row.id;
  end if;

  delete from public.mold_piece_types where organization_id = p_org_id and mold_id = v_id;
  insert into public.mold_piece_types (organization_id, mold_id, piece_type_id)
    select p_org_id, v_id, selected.piece_type_id
    from unnest(coalesce(p_piece_type_ids, '{}'::uuid[])) as selected(piece_type_id);
  return to_jsonb(v_row);
end;
$$;

alter table public.works enable row level security;
alter table public.molds enable row level security;
alter table public.mold_piece_types enable row level security;
alter table public.mold_preparations enable row level security;
alter table public.resource_allocations enable row level security;

revoke all on function public.save_work_record(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.save_order_with_items(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_piece_type(uuid, jsonb, uuid[]) from public, anon, authenticated;
revoke all on function public.save_mold(uuid, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.save_work_record(uuid, jsonb) to service_role;
grant execute on function public.save_order_with_items(uuid, jsonb, jsonb) to service_role;
grant execute on function public.save_piece_type(uuid, jsonb, uuid[]) to service_role;
grant execute on function public.save_mold(uuid, jsonb, uuid[]) to service_role;
