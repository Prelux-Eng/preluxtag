-- Exclusão definitiva só para registros sem produção ou histórico dependente.
-- A RPC valida e apaga na mesma transação; a interface nunca apaga tabelas
-- diretamente. O registro de auditoria guarda a identificação excluída.
create function public.delete_operation_record(
  p_org_id uuid, p_kind text, p_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_order public.orders;
  v_piece public.piece_types;
  v_mold public.molds;
  v_had_plan boolean := false;
  v_description text;
begin
  if p_kind = 'order' then
    select * into v_order from public.orders
      where organization_id = p_org_id and id = p_id for update;
    if not found then raise exception 'Pedido não encontrado.' using errcode = 'P0002'; end if;
    if v_order.status in ('concluido', 'entregue')
      or public.factory_order_has_started_production(p_org_id, p_id)
      or exists (select 1 from public.production_labels l
        where l.organization_id = p_org_id and l.order_id = p_id) then
      raise exception 'Pedido com produção iniciada, concluída ou etiquetas não pode ser apagado. Preserve o histórico.' using errcode = '23514';
    end if;
    if exists (select 1 from public.resource_allocations a
      join public.order_items oi on oi.id = a.order_item_id
      where oi.organization_id = p_org_id and oi.order_id = p_id)
      or exists (select 1 from public.stock_movements sm
        where sm.organization_id = p_org_id and sm.order_id = p_id)
      or exists (select 1 from public.delay_adjustments da
        where da.organization_id = p_org_id and da.order_id = p_id) then
      raise exception 'Pedido com alocações, movimentações ou ajustes registrados não pode ser apagado.' using errcode = '23514';
    end if;
    select exists (select 1 from public.production_orders po
      where po.organization_id = p_org_id and po.order_id = p_id)
      into v_had_plan;
    v_description := coalesce(nullif(v_order.order_number, ''), p_id::text);
    delete from public.orders where organization_id = p_org_id and id = p_id;

  elsif p_kind = 'piece_type' then
    select * into v_piece from public.piece_types
      where organization_id = p_org_id and id = p_id for update;
    if not found then raise exception 'Peça não encontrada.' using errcode = 'P0002'; end if;
    if exists (select 1 from public.order_items oi
      where oi.organization_id = p_org_id and oi.piece_type_id = p_id)
      or exists (select 1 from public.production_schedules ps
        where ps.organization_id = p_org_id and ps.piece_type_id = p_id)
      or exists (select 1 from public.stock_movements sm
        where sm.organization_id = p_org_id and sm.piece_type_id = p_id)
      or exists (select 1 from public.stock_reservations sr
        where sr.organization_id = p_org_id and sr.piece_type_id = p_id) then
      raise exception 'Peça usada por pedido, produção ou estoque não pode ser apagada. Use Arquivar.' using errcode = '23514';
    end if;
    v_description := v_piece.code;
    delete from public.piece_types where organization_id = p_org_id and id = p_id;

  elsif p_kind = 'mold' then
    select * into v_mold from public.molds
      where organization_id = p_org_id and id = p_id for update;
    if not found then raise exception 'Forma não encontrada.' using errcode = 'P0002'; end if;
    if exists (select 1 from public.mold_preparations mp
      where mp.organization_id = p_org_id and mp.mold_id = p_id)
      or exists (select 1 from public.resource_allocations ra
        where ra.organization_id = p_org_id and ra.mold_id = p_id) then
      raise exception 'Forma com preparações ou alocações registradas não pode ser apagada. Use Retirar.' using errcode = '23514';
    end if;
    v_description := v_mold.code;
    delete from public.molds where organization_id = p_org_id and id = p_id;

  else
    raise exception 'Tipo de registro inválido.' using errcode = '22023';
  end if;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, payload)
    values (p_org_id, p_kind, p_id, 'delete',
      pg_catalog.jsonb_build_object('description', v_description, 'hadPlan', v_had_plan));
  return pg_catalog.jsonb_build_object('kind', p_kind, 'id', p_id, 'hadPlan', v_had_plan);
end;
$function$;
revoke all on function public.delete_operation_record(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_operation_record(uuid, text, uuid)
  to service_role;
