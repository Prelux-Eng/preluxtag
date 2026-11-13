-- Cada unidade produzida fica pronta após todas as etapas; o pedido é
-- concluído somente quando todas as unidades solicitadas estão prontas.
alter table public.orders drop constraint if exists orders_status_not_concluido_check;
alter table public.production_orders drop constraint if exists production_orders_status_check;
alter table public.production_orders add constraint production_orders_status_check
  check (status in ('planned', 'in_progress', 'done', 'pronta', 'cancelled', 'scrapped'));

create or replace function public.order_all_units_ready(p_org_id uuid, p_order_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $function$
  select exists (
    select 1 from public.order_items oi
    where oi.organization_id = p_org_id and oi.order_id = p_order_id
  ) and not exists (
    select 1 from public.order_items oi
    where oi.organization_id = p_org_id and oi.order_id = p_order_id
      and (select count(*) from public.production_orders po
        where po.organization_id = p_org_id and po.order_item_id = oi.id
          and po.status = 'pronta') <> oi.quantity
  ) and not exists (
    select 1 from public.production_orders po
    where po.organization_id = p_org_id and po.order_id = p_order_id
      and po.status not in ('pronta', 'cancelled')
  );
$function$;
revoke all on function public.order_all_units_ready(uuid, uuid) from public, anon, authenticated;
grant execute on function public.order_all_units_ready(uuid, uuid) to service_role;

create or replace function public.guard_ready_unit()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.status = 'pronta' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not exists (select 1 from public.production_order_steps s
      where s.organization_id = new.organization_id and s.production_order_id = new.id and s.step_kind = 'concretagem')
      or not exists (select 1 from public.production_order_steps s
        where s.organization_id = new.organization_id and s.production_order_id = new.id and s.step_kind = 'cura')
      or not exists (select 1 from public.production_order_steps s
        where s.organization_id = new.organization_id and s.production_order_id = new.id and s.step_kind = 'acabamento')
      or exists (select 1 from public.production_order_steps s
        where s.organization_id = new.organization_id and s.production_order_id = new.id and s.status <> 'done') then
      raise exception 'A peça só fica pronta após concluir concretagem, cura, acabamento e todas as demais etapas registradas.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.guard_ready_unit() from public, anon, authenticated;
drop trigger if exists trg_guard_ready_unit on public.production_orders;
create trigger trg_guard_ready_unit before insert or update of status on public.production_orders
for each row execute function public.guard_ready_unit();

create or replace function public.guard_completed_order()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.status = 'concluido' and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and not public.order_all_units_ready(new.organization_id, new.id) then
    raise exception 'O pedido só pode ser concluído quando todas as unidades estiverem prontas.' using errcode = '23514';
  end if;
  return new;
end;
$function$;
revoke all on function public.guard_completed_order() from public, anon, authenticated;
drop trigger if exists trg_guard_completed_order on public.orders;
create trigger trg_guard_completed_order before insert or update of status on public.orders
for each row execute function public.guard_completed_order();

create or replace function public.complete_production_step(p_org_id uuid, p_step_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_step public.production_order_steps;
  v_unit public.production_orders;
  v_order public.orders;
  v_now timestamptz := pg_catalog.now();
begin
  select s.* into v_step from public.production_order_steps s
  where s.organization_id = p_org_id and s.id = p_step_id for update;
  if not found then raise exception 'Etapa de produção não encontrada.' using errcode = '23503'; end if;
  select po.* into v_unit from public.production_orders po
  where po.organization_id = p_org_id and po.id = v_step.production_order_id for update;
  select o.* into v_order from public.orders o
  where o.organization_id = p_org_id and o.id = v_unit.order_id for update;
  if v_order.status in ('orcamento', 'cancelado', 'entregue', 'concluido')
    or v_unit.status in ('cancelled', 'scrapped') or v_step.status = 'cancelled' then
    raise exception 'Esta produção não aceita conclusão de etapa.' using errcode = '23514';
  end if;
  if v_step.status <> 'done' then
    if exists (select 1 from public.production_order_steps prior
      where prior.organization_id = p_org_id and prior.production_order_id = v_unit.id
        and prior.sequence < v_step.sequence and prior.status <> 'done') then
      raise exception 'Conclua as etapas anteriores antes desta.' using errcode = '23514';
    end if;
    update public.production_order_steps s set status = 'done',
      actual_start_at = coalesce(s.actual_start_at, v_now), actual_end_at = v_now
    where s.organization_id = p_org_id and s.id = p_step_id;
  end if;
  if v_step.step_kind = 'concretagem' then
    update public.allocations a set status = 'done', released_at = coalesce(a.released_at, v_now)
    where a.organization_id = p_org_id and a.production_order_id = v_unit.id
      and a.status in ('planned', 'in_progress');
  end if;
  if not exists (select 1 from public.production_order_steps s
    where s.organization_id = p_org_id and s.production_order_id = v_unit.id and s.status <> 'done')
    and exists (select 1 from public.production_order_steps s
      where s.organization_id = p_org_id and s.production_order_id = v_unit.id and s.step_kind = 'acabamento') then
    update public.production_orders po set status = 'pronta'
    where po.organization_id = p_org_id and po.id = v_unit.id and po.status <> 'pronta';
  elsif v_unit.status = 'planned' then
    update public.production_orders po set status = 'in_progress'
    where po.organization_id = p_org_id and po.id = v_unit.id;
  end if;
  if public.order_all_units_ready(p_org_id, v_unit.order_id) then
    update public.orders o set status = 'concluido'
    where o.organization_id = p_org_id and o.id = v_unit.order_id and o.status <> 'concluido';
  elsif v_order.status in ('aprovado', 'atrasado') then
    update public.orders o set status = 'em_producao'
    where o.organization_id = p_org_id and o.id = v_unit.order_id;
  end if;
  return pg_catalog.jsonb_build_object('orderId', v_unit.order_id, 'productionOrderId', v_unit.id,
    'stepId', p_step_id, 'stepKind', v_step.step_kind,
    'unitStatus', (select po.status from public.production_orders po where po.id = v_unit.id),
    'orderStatus', (select o.status from public.orders o where o.id = v_unit.order_id));
end;
$function$;
revoke all on function public.complete_production_step(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_production_step(uuid, uuid) to service_role;
