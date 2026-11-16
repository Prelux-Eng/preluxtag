-- A retirada de uma unidade reduz a quantidade contratada sem apagar etapas
-- executadas. Se ela era a última do item, uma cópia integral vai para a
-- auditoria antes da remoção física do item e de suas dependências.

-- A forma montada precisa continuar conhecida mesmo quando a última unidade
-- que a utilizou é removida do pedido. Estes eventos não dependem da unidade.
create table public.withdrawn_unit_form_events (
  source_allocation_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_unit_id uuid not null,
  mold_position_id uuid not null references public.mold_positions(id) on delete restrict,
  mold_catalog_codes text[] not null,
  occupied_until_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (cardinality(mold_catalog_codes) > 0)
);
create index withdrawn_unit_form_events_position_idx
  on public.withdrawn_unit_form_events (organization_id, mold_position_id, occupied_until_at desc);
alter table public.withdrawn_unit_form_events enable row level security;
revoke all on public.withdrawn_unit_form_events from public, anon, authenticated;
grant select on public.withdrawn_unit_form_events to service_role;

create or replace function public.factory_installed_form_by_position(p_org_id uuid)
returns table(mold_position_id uuid, mold_catalog_codes text[])
language sql stable security invoker set search_path = '' as $function$
  with form_events as (
    select a.mold_position_id, a.mold_catalog_codes,
      coalesce(a.occupied_until_at, a.scheduled_date::timestamptz) as event_at,
      a.id as source_id
    from public.allocations a
    join public.production_orders po
      on po.organization_id = a.organization_id and po.id = a.production_order_id
    where a.organization_id = p_org_id and a.status <> 'cancelled'
      and pg_catalog.cardinality(a.mold_catalog_codes) > 0
      and (a.status = 'done' or po.status in ('done', 'pronta')
        or exists (select 1 from public.production_order_steps s
          where s.organization_id = po.organization_id and s.production_order_id = po.id
            and s.step_kind in ('preparacao', 'concretagem') and s.status = 'done'))
    union all
    select e.mold_position_id, e.mold_catalog_codes, e.occupied_until_at,
      e.source_allocation_id
    from public.withdrawn_unit_form_events e where e.organization_id = p_org_id
  )
  select distinct on (e.mold_position_id)
    e.mold_position_id, e.mold_catalog_codes
  from form_events e
  join public.mold_positions mp on mp.id = e.mold_position_id and mp.organization_id = p_org_id
  where mp.form_reset_at is null or e.event_at > mp.form_reset_at
  order by e.mold_position_id, e.event_at desc, e.source_id desc;
$function$;

create function public.withdraw_production_unit(
  p_org_id uuid, p_unit_id uuid, p_section_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_unit public.production_orders;
  v_item public.order_items;
  v_order public.orders;
  v_section_item public.project_section_items;
  v_section_count integer := 0;
  v_default_section_id uuid;
  v_schedule public.production_schedules;
  v_cast_done boolean := false;
  v_snapshot jsonb;
  v_item_removed boolean := false;
  v_remaining integer;
begin
  -- A mesma revisão é bloqueada pelo commit do Planejamento. Assim a retirada
  -- não atravessa uma confirmação de cenário feita ao mesmo tempo.
  perform 1 from public.factory_plan_revisions r
    where r.organization_id = p_org_id for update;
  if not found then
    raise exception 'Unidade de Planejamento não inicializada.' using errcode = '23503';
  end if;
  select * into v_unit from public.production_orders po
    where po.organization_id = p_org_id and po.id = p_unit_id;
  if not found then raise exception 'Unidade de peça não encontrada.' using errcode = 'P0002'; end if;
  select * into v_order from public.orders o
    where o.organization_id = p_org_id and o.id = v_unit.order_id for update;
  select * into v_item from public.order_items oi
    where oi.organization_id = p_org_id and oi.id = v_unit.order_item_id for update;
  select * into v_unit from public.production_orders po
    where po.organization_id = p_org_id and po.id = p_unit_id for update;
  if v_order.id is null or v_item.id is null or v_unit.id is null
    or v_item.order_id <> v_order.id then
    raise exception 'Pedido, item ou unidade não está mais disponível.' using errcode = 'P0002';
  end if;
  if v_unit.status not in ('planned', 'in_progress')
    or v_order.status in ('concluido', 'entregue', 'cancelado')
    or exists (select 1 from public.production_labels l
      where l.organization_id = p_org_id and l.production_order_id = p_unit_id) then
    raise exception 'Somente uma unidade planejada ou em produção, sem etiqueta, pode ser retirada.' using errcode = '23514';
  end if;
  if exists (select 1 from public.stock_reservations sr
      where sr.organization_id = p_org_id and sr.order_item_id = v_item.id)
    or exists (select 1 from public.stock_movements sm
      where sm.organization_id = p_org_id and sm.order_id = v_order.id
        and sm.piece_type_id = v_item.piece_type_id) then
    raise exception 'Este item tem movimentação ou reserva de estoque. Ajuste o estoque antes de retirar a unidade.' using errcode = '23514';
  end if;
  if v_item.quantity = 1 and (select count(*) from public.production_orders po
      where po.organization_id = p_org_id and po.order_item_id = v_item.id
        and po.status <> 'cancelled') <> 1 then
    raise exception 'A última unidade só pode ser retirada quando não há outra unidade ativa no item.' using errcode = '23514';
  end if;
  if v_item.quantity = 1 and exists (select 1 from public.production_labels l
    join public.production_orders po on po.id = l.production_order_id
    where po.organization_id = p_org_id and po.order_item_id = v_item.id) then
    raise exception 'Um item com etiqueta gerada não pode ser retirado.' using errcode = '23514';
  end if;

  select count(*), min(psi.section_id) into v_section_count, v_default_section_id
  from public.project_section_items psi
  join public.project_sections ps on ps.id = psi.section_id and ps.organization_id = psi.organization_id
  join public.engineering_projects ep on ep.id = ps.project_id and ep.organization_id = ps.organization_id
  where psi.organization_id = p_org_id and psi.order_item_id = v_item.id
    and ep.order_id = v_order.id;
  if v_item.quantity > 1 then
    if v_section_count > 1 and p_section_id is null then
      raise exception 'Escolha a seção do projeto cuja quantidade será reduzida.' using errcode = '22023';
    end if;
    if v_section_count > 0 then
      select * into v_section_item from public.project_section_items psi
      where psi.organization_id = p_org_id and psi.order_item_id = v_item.id
        and psi.section_id = coalesce(p_section_id, v_default_section_id) for update;
      if not found then raise exception 'A seção escolhida não contém este item.' using errcode = '22023'; end if;
    elsif p_section_id is not null then
      raise exception 'Este item não está distribuído na seção escolhida.' using errcode = '22023';
    end if;
  end if;

  select exists (select 1 from public.production_order_steps s
    where s.organization_id = p_org_id and s.production_order_id = p_unit_id
      and s.step_kind = 'concretagem' and s.status = 'done') into v_cast_done;
  -- A auditoria registra o estado anterior. Na retirada do último item ela
  -- inclui todos os registros que serão apagados por cascata.
  select pg_catalog.jsonb_build_object(
    'unit', pg_catalog.to_jsonb(v_unit), 'orderItem', pg_catalog.to_jsonb(v_item),
    'orderNumber', v_order.order_number,
    'units', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(po)), '[]'::jsonb)
      from public.production_orders po where po.organization_id = p_org_id
        and po.order_item_id = v_item.id and (v_item.quantity = 1 or po.id = p_unit_id)),
    'steps', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)), '[]'::jsonb)
      from public.production_order_steps s join public.production_orders po
        on po.id = s.production_order_id and po.organization_id = s.organization_id
      where po.organization_id = p_org_id and po.order_item_id = v_item.id
        and (v_item.quantity = 1 or po.id = p_unit_id)),
    'allocations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a)), '[]'::jsonb)
      from public.allocations a join public.production_orders po
        on po.id = a.production_order_id and po.organization_id = a.organization_id
      where po.organization_id = p_org_id and po.order_item_id = v_item.id
        and (v_item.quantity = 1 or po.id = p_unit_id)),
    'schedules', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ps)), '[]'::jsonb)
      from public.production_schedules ps where ps.organization_id = p_org_id
        and ps.order_item_id = v_item.id),
    'projectSections', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(psi)), '[]'::jsonb)
      from public.project_section_items psi where psi.organization_id = p_org_id
        and psi.order_item_id = v_item.id),
    'resourceAllocations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ra)), '[]'::jsonb)
      from public.resource_allocations ra where ra.organization_id = p_org_id
        and ra.order_item_id = v_item.id),
    'engineeringProject', (select pg_catalog.to_jsonb(ep) from public.engineering_projects ep
      where ep.organization_id = p_org_id and ep.order_id = v_order.id),
    'projectSectionsMetadata', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ps)), '[]'::jsonb)
      from public.project_sections ps join public.engineering_projects ep
        on ep.id = ps.project_id and ep.organization_id = ps.organization_id
      where ep.organization_id = p_org_id and ep.order_id = v_order.id)
  ) into v_snapshot;

  -- Um evento independente mantém o estado físico da forma após a cascata.
  insert into public.withdrawn_unit_form_events (
    source_allocation_id, organization_id, source_unit_id, mold_position_id,
    mold_catalog_codes, occupied_until_at
  )
  select a.id, a.organization_id, po.id, a.mold_position_id,
    a.mold_catalog_codes, coalesce(a.occupied_until_at, a.scheduled_date::timestamptz)
  from public.allocations a join public.production_orders po
    on po.id = a.production_order_id and po.organization_id = a.organization_id
  where po.organization_id = p_org_id and po.order_item_id = v_item.id
    and (v_item.quantity = 1 or po.id = p_unit_id)
    and a.status <> 'cancelled' and pg_catalog.cardinality(a.mold_catalog_codes) > 0
    and (a.status = 'done' or exists (select 1 from public.production_order_steps s
      where s.organization_id = p_org_id and s.production_order_id = po.id
        and s.step_kind in ('preparacao', 'concretagem') and s.status = 'done'))
  on conflict (source_allocation_id) do nothing;

  if v_item.quantity > 1 then
    if v_section_item.id is not null then
      if v_section_item.quantity > 1 then
        update public.project_section_items set quantity = quantity - 1
        where organization_id = p_org_id and id = v_section_item.id;
      else
        delete from public.project_section_items
        where organization_id = p_org_id and id = v_section_item.id;
        delete from public.project_sections ps
        where ps.organization_id = p_org_id and ps.id = v_section_item.section_id
          and not exists (select 1 from public.project_section_items psi
            where psi.organization_id = p_org_id and psi.section_id = ps.id);
      end if;
    end if;
    select * into v_schedule from public.production_schedules ps
    where ps.organization_id = p_org_id and ps.order_item_id = v_item.id
      and ps.work_date = v_unit.planned_cast_date for update;
    if found then
      if v_schedule.planned_quantity > 1 then
        update public.production_schedules ps set
          planned_quantity = ps.planned_quantity - 1,
          planned_minutes = greatest(1, ps.planned_minutes
            - pg_catalog.ceil(ps.planned_minutes::numeric / ps.planned_quantity)::integer),
          actual_quantity = greatest(0, ps.actual_quantity - case when v_cast_done then 1 else 0 end)
        where ps.organization_id = p_org_id and ps.id = v_schedule.id;
      else
        delete from public.production_schedules ps
        where ps.organization_id = p_org_id and ps.id = v_schedule.id;
      end if;
    end if;
    update public.production_order_steps s set status = 'cancelled'
      where s.organization_id = p_org_id and s.production_order_id = p_unit_id
        and s.status in ('planned', 'in_progress');
    update public.allocations a set status = 'cancelled',
      released_at = greatest(pg_catalog.now(), coalesce(a.assigned_at, pg_catalog.now()))
      where a.organization_id = p_org_id and a.production_order_id = p_unit_id
        and a.status in ('planned', 'in_progress');
    update public.production_orders po set status = 'cancelled'
      where po.organization_id = p_org_id and po.id = p_unit_id;
    update public.order_items oi set quantity = oi.quantity - 1
      where oi.organization_id = p_org_id and oi.id = v_item.id;
    v_remaining := v_item.quantity - 1;
  else
    -- A última unidade não pode deixar um item com quantidade zero. O estado
    -- completo já está em v_snapshot e a forma montada está no evento acima.
    if not exists (select 1 from public.order_items oi
      where oi.organization_id = p_org_id and oi.order_id = v_order.id and oi.id <> v_item.id) then
      delete from public.engineering_projects ep
      where ep.organization_id = p_org_id and ep.order_id = v_order.id;
    end if;
    delete from public.resource_allocations ra
      where ra.organization_id = p_org_id and ra.order_item_id = v_item.id;
    delete from public.production_orders po
      where po.organization_id = p_org_id and po.order_item_id = v_item.id;
    delete from public.order_items oi
      where oi.organization_id = p_org_id and oi.id = v_item.id;
    delete from public.project_sections ps
      where ps.organization_id = p_org_id
        and ps.project_id in (select ep.id from public.engineering_projects ep
          where ep.organization_id = p_org_id and ep.order_id = v_order.id)
        and not exists (select 1 from public.project_section_items psi
          where psi.organization_id = p_org_id and psi.section_id = ps.id);
    v_item_removed := true;
    v_remaining := 0;
  end if;

  if not exists (select 1 from public.order_items oi
    where oi.organization_id = p_org_id and oi.order_id = v_order.id) then
    update public.orders o set status = 'orcamento', approved_at = null,
      planned_start_date = null, planned_end_date = null, forecast_end_date = null
    where o.organization_id = p_org_id and o.id = v_order.id;
  elsif public.order_all_units_ready(p_org_id, v_order.id) then
    update public.orders o set status = 'concluido'
    where o.organization_id = p_org_id and o.id = v_order.id;
  elsif not public.factory_order_has_started_production(p_org_id, v_order.id)
    and v_order.status = 'em_producao' then
    update public.orders o set status = 'aprovado'
    where o.organization_id = p_org_id and o.id = v_order.id;
  end if;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, payload)
  values (p_org_id, 'production_orders', p_unit_id, 'withdraw',
    pg_catalog.jsonb_build_object('itemRemoved', v_item_removed,
      'quantityAfter', v_remaining, 'before', v_snapshot));
  return pg_catalog.jsonb_build_object('orderId', v_order.id, 'orderItemId', v_item.id,
    'unitId', p_unit_id, 'itemRemoved', v_item_removed, 'quantityAfter', v_remaining,
    'orderStatus', (select o.status from public.orders o where o.id = v_order.id));
end;
$function$;
revoke all on function public.withdraw_production_unit(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.withdraw_production_unit(uuid, uuid, uuid)
  to service_role;
