-- Permite alterar o cliente da obra mesmo quando ela já possui pedidos.
-- O cliente continua sendo herdado por todos os pedidos vinculados; a data de
-- início permanece protegida depois que qualquer pedido começa a produção.

begin;

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
  if v_name is null or v_client_id is null then
    raise exception 'Informe o nome da obra e o cliente.';
  end if;

  if not exists (
    select 1 from public.clients
    where id = v_client_id and organization_id = p_org_id and is_active
  ) then
    raise exception 'Cliente não encontrado nesta unidade.';
  end if;

  if nullif(p_record->>'requestedDueDate', '') is not null
    and nullif(p_record->>'startDate', '') is not null
    and (p_record->>'requestedDueDate')::date < (p_record->>'startDate')::date then
    raise exception 'O prazo da obra não pode ser anterior ao início.';
  end if;

  if v_id is not null then
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

    if not found then
      raise exception 'Obra não encontrada.';
    end if;
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

create or replace function public.sync_work_fields_to_orders()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.client_id is not distinct from old.client_id
    and new.start_date is not distinct from old.start_date then
    return new;
  end if;

  -- Alterar o cliente da obra é permitido a qualquer momento. A data de início
  -- continua protegida quando já existe produção iniciada ou concluída.
  if new.start_date is distinct from old.start_date then
    if exists (
      select 1
      from public.orders o
      left join public.production_orders po
        on po.organization_id = o.organization_id and po.order_id = o.id
      left join public.production_schedules ps
        on ps.organization_id = o.organization_id and ps.order_id = o.id
      where o.organization_id = new.organization_id and o.work_id = new.id
        and (
          o.status in ('em_producao','concluido','entregue')
          or po.status in ('in_progress','done','scrapped')
          or ps.status in ('in_progress','done')
        )
    ) then
      raise exception 'Não é possível alterar a data de início depois que um pedido vinculado começou a produção.';
    end if;

    if exists (
      select 1 from public.orders o
      where o.organization_id = new.organization_id and o.work_id = new.id
        and (new.start_date is null or (o.requested_due_date is not null and o.requested_due_date < new.start_date))
    ) then
      raise exception 'A data da obra precisa ser informada e não pode ultrapassar o prazo solicitado de um pedido vinculado.';
    end if;
  end if;

  -- Os pedidos herdam o novo cliente mesmo quando já estão em produção.
  update public.orders o
  set client_id = new.client_id,
      start_date = new.start_date
  where o.organization_id = new.organization_id and o.work_id = new.id
    and (o.client_id is distinct from new.client_id or o.start_date is distinct from new.start_date);

  return new;
end;
$$;

commit;
