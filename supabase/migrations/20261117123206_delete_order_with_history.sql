-- Permite apagar pedidos em qualquer etapa operacional. Antes das cascatas,
-- o conteúdo dependente é copiado para auditoria e as posições já ocupadas
-- continuam conhecidas pelo Planejamento.
create function public.delete_order_with_history(p_org_id uuid, p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_order public.orders;
  v_had_plan boolean := false;
  v_snapshot jsonb;
  v_description text;
begin
  -- Serializa com a confirmação do Planejamento para evitar apagar um pedido
  -- enquanto a fila está sendo confirmada.
  perform 1 from public.factory_plan_revisions r
    where r.organization_id = p_org_id for update;
  if not found then
    raise exception 'Unidade de Planejamento não inicializada.' using errcode = '23503';
  end if;

  select * into v_order from public.orders o
  where o.organization_id = p_org_id and o.id = p_order_id for update;
  if not found then raise exception 'Pedido não encontrado.' using errcode = 'P0002'; end if;

  select exists (select 1 from public.production_orders po
      where po.organization_id = p_org_id and po.order_id = p_order_id)
    or exists (select 1 from public.production_schedules ps
      where ps.organization_id = p_org_id and ps.order_id = p_order_id)
    into v_had_plan;

  select pg_catalog.jsonb_build_object(
    'order', pg_catalog.to_jsonb(v_order),
    'items', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi)), '[]'::jsonb)
      from public.order_items oi where oi.organization_id = p_org_id and oi.order_id = p_order_id),
    'productionUnits', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(po)), '[]'::jsonb)
      from public.production_orders po where po.organization_id = p_org_id and po.order_id = p_order_id),
    'productionSteps', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)), '[]'::jsonb)
      from public.production_order_steps s join public.production_orders po
        on po.organization_id = s.organization_id and po.id = s.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id),
    'positionAllocations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a)), '[]'::jsonb)
      from public.allocations a join public.production_orders po
        on po.organization_id = a.organization_id and po.id = a.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id),
    'productionSchedules', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ps)), '[]'::jsonb)
      from public.production_schedules ps where ps.organization_id = p_org_id and ps.order_id = p_order_id),
    'labels', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l)), '[]'::jsonb)
      from public.production_labels l where l.organization_id = p_org_id and l.order_id = p_order_id),
    'resourceAllocations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ra)), '[]'::jsonb)
      from public.resource_allocations ra join public.order_items oi
        on oi.organization_id = ra.organization_id and oi.id = ra.order_item_id
      where oi.organization_id = p_org_id and oi.order_id = p_order_id),
    'stockReservations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(sr)), '[]'::jsonb)
      from public.stock_reservations sr join public.order_items oi
        on oi.organization_id = sr.organization_id and oi.id = sr.order_item_id
      where oi.organization_id = p_org_id and oi.order_id = p_order_id),
    'stockMovements', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(sm)), '[]'::jsonb)
      from public.stock_movements sm where sm.organization_id = p_org_id and sm.order_id = p_order_id),
    'delayAdjustments', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(da)), '[]'::jsonb)
      from public.delay_adjustments da where da.organization_id = p_org_id and da.order_id = p_order_id),
    'engineeringProjects', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ep)), '[]'::jsonb)
      from public.engineering_projects ep where ep.organization_id = p_org_id and ep.order_id = p_order_id),
    'projectSections', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ps)), '[]'::jsonb)
      from public.project_sections ps join public.engineering_projects ep
        on ep.organization_id = ps.organization_id and ep.id = ps.project_id
      where ep.organization_id = p_org_id and ep.order_id = p_order_id),
    'projectSectionItems', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(psi)), '[]'::jsonb)
      from public.project_section_items psi join public.project_sections ps
        on ps.organization_id = psi.organization_id and ps.id = psi.section_id
      join public.engineering_projects ep
        on ep.organization_id = ps.organization_id and ep.id = ps.project_id
      where ep.organization_id = p_org_id and ep.order_id = p_order_id)
  ) into v_snapshot;

  -- Mantém a forma montada e a reserva do dia de concretagem mesmo que as
  -- alocações sejam removidas pelas cascatas do pedido.
  insert into public.withdrawn_unit_form_events (
    source_allocation_id, organization_id, source_unit_id, mold_position_id,
    mold_catalog_codes, occupied_until_at
  )
  select a.id, a.organization_id, po.id, a.mold_position_id,
    a.mold_catalog_codes, coalesce(a.occupied_until_at, a.scheduled_date::timestamptz)
  from public.allocations a join public.production_orders po
    on po.organization_id = a.organization_id and po.id = a.production_order_id
  where po.organization_id = p_org_id and po.order_id = p_order_id
    and a.status <> 'cancelled' and pg_catalog.cardinality(a.mold_catalog_codes) > 0
    and (a.status = 'done' or exists (select 1 from public.production_order_steps s
      where s.organization_id = p_org_id and s.production_order_id = po.id
        and s.step_kind in ('preparacao', 'concretagem') and s.status = 'done'))
  on conflict (source_allocation_id) do nothing;

  -- Estas duas tabelas restringem a exclusão do pedido. Seus retratos já
  -- foram guardados no payload de auditoria acima.
  delete from public.resource_allocations ra using public.order_items oi
    where ra.organization_id = p_org_id and oi.organization_id = p_org_id
      and ra.order_item_id = oi.id and oi.order_id = p_order_id;
  delete from public.production_labels l
    where l.organization_id = p_org_id and l.order_id = p_order_id;

  -- Remove as unidades primeiro para que a proteção de exclusão de item não
  -- veja produção ativa durante a cascata dos itens do pedido.
  delete from public.production_orders po
    where po.organization_id = p_org_id and po.order_id = p_order_id;

  v_description := coalesce(nullif(v_order.order_number, ''), p_order_id::text);
  delete from public.orders where organization_id = p_org_id and id = p_order_id;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, payload)
    values (p_org_id, 'orders', p_order_id, 'delete',
      pg_catalog.jsonb_build_object('description', v_description,
        'hadPlan', v_had_plan, 'history', v_snapshot));
  return pg_catalog.jsonb_build_object('kind', 'order', 'id', p_order_id,
    'hadPlan', v_had_plan, 'historyArchived', true);
end;
$function$;
revoke all on function public.delete_order_with_history(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_order_with_history(uuid, uuid)
  to service_role;
