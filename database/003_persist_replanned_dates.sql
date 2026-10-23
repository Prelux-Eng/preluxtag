-- PRELUX · persiste início, prazo e fim ao confirmar um replanejamento

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
  schedule_row jsonb;
  item_row jsonb;
  item_id uuid;
  piece_type_id uuid;
  schedule_count integer := 0;
  reservation_count integer := 0;
  planned_end date;
  total_to_produce integer := coalesce((p_plan->>'totalToProduce')::integer, 0);
begin
  if p_plan is null or jsonb_typeof(p_plan->'schedules') <> 'array' then
    raise exception 'Plano inválido: schedules precisa ser uma lista';
  end if;

  if not exists (
    select 1 from public.orders
    where id = p_order_id and organization_id = p_org_id and is_active = true
  ) then
    raise exception 'Pedido não encontrado';
  end if;

  if exists (
    select 1 from public.production_schedules
    where order_id = p_order_id and status in ('in_progress', 'done')
  ) then
    raise exception 'Pedido já possui produção iniciada ou concluída; não é possível substituir o plano';
  end if;

  delete from public.production_schedules
  where order_id = p_order_id and organization_id = p_org_id and status = 'planned';

  update public.stock_reservations
  set status = 'released', updated_at = now()
  where order_id = p_order_id and organization_id = p_org_id and status = 'reserved';

  for schedule_row in select value from jsonb_array_elements(p_plan->'schedules')
  loop
    item_id := (schedule_row->>'itemId')::uuid;
    piece_type_id := (schedule_row->>'pieceTypeId')::uuid;

    if not exists (
      select 1 from public.order_items
      where id = item_id and order_id = p_order_id and organization_id = p_org_id
    ) then
      raise exception 'Item do pedido não pertence ao pedido informado';
    end if;

    insert into public.production_schedules (
      organization_id, order_id, order_item_id, piece_type_id,
      work_date, planned_quantity, planned_minutes, status
    ) values (
      p_org_id,
      p_order_id,
      item_id,
      piece_type_id,
      (schedule_row->>'workDate')::date,
      (schedule_row->>'plannedQuantity')::integer,
      (schedule_row->>'plannedMinutes')::integer,
      'planned'
    );
    schedule_count := schedule_count + 1;
  end loop;

  for item_row in select value from jsonb_array_elements(coalesce(p_plan->'items', '[]'::jsonb))
  loop
    if coalesce((item_row->>'stockQuantityUsed')::integer, 0) > 0 then
      item_id := (item_row->>'itemId')::uuid;
      piece_type_id := (item_row->>'pieceTypeId')::uuid;

      insert into public.stock_reservations (
        organization_id, order_id, order_item_id, piece_type_id, quantity, status
      ) values (
        p_org_id,
        p_order_id,
        item_id,
        piece_type_id,
        (item_row->>'stockQuantityUsed')::integer,
        'reserved'
      )
      on conflict (order_item_id) do update
        set piece_type_id = excluded.piece_type_id,
            quantity = excluded.quantity,
            status = 'reserved',
            updated_at = now();
      reservation_count := reservation_count + 1;
    end if;
  end loop;

  planned_end := case
    when coalesce(p_plan->>'plannedEndDate', '') = '' then null
    else (p_plan->>'plannedEndDate')::date
  end;

  update public.orders
  set start_date = coalesce(nullif(p_plan->>'startDate', '')::date, start_date),
      requested_due_date = nullif(p_plan->>'dueDate', '')::date,
      planned_end_date = planned_end,
      status = case
        when total_to_produce > 0 then 'em_producao'::public.order_status
        when status in ('orcamento', 'aprovado') then 'aprovado'::public.order_status
        else status
      end,
      updated_at = now()
  where id = p_order_id and organization_id = p_org_id;

  insert into public.audit_logs (
    organization_id, entity_name, entity_id, action, actor_label, payload
  ) values (
    p_org_id, 'orders', p_order_id, 'plan_committed', 'acesso-publico', p_plan
  );

  return jsonb_build_object(
    'orderId', p_order_id,
    'scheduleCount', schedule_count,
    'reservationCount', reservation_count,
    'plannedEndDate', planned_end
  );
end;
$$;

revoke all on function public.commit_order_plan(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_order_plan(uuid, uuid, jsonb) to service_role;
