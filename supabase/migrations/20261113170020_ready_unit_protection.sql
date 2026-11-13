-- Unidades prontas também contam como produção iniciada. Assim, uma
-- reconfirmação do plano ou exclusão de item não apaga a produção concluída.
create or replace function public.factory_order_has_started_production(
  p_org_id uuid, p_order_id uuid
)
returns boolean language sql security definer set search_path = '' as $function$
  select
    exists (
      select 1 from public.production_orders po
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and po.status in ('in_progress', 'done', 'pronta', 'scrapped')
    ) or exists (
      select 1 from public.production_order_steps s
      join public.production_orders po
        on po.organization_id = s.organization_id and po.id = s.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and s.status in ('in_progress', 'done')
    ) or exists (
      select 1 from public.allocations a
      join public.production_orders po
        on po.organization_id = a.organization_id and po.id = a.production_order_id
      where po.organization_id = p_org_id and po.order_id = p_order_id
        and a.status in ('in_progress', 'done')
    ) or exists (
      select 1 from public.production_schedules ps
      where ps.organization_id = p_org_id and ps.order_id = p_order_id
        and ps.status in ('in_progress', 'done')
    );
$function$;

create or replace function public.guard_started_production_order_item_delete()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if exists (
    select 1 from public.production_orders po
    where po.organization_id = old.organization_id and po.order_item_id = old.id
      and po.status in ('in_progress', 'done', 'pronta', 'scrapped')
  ) or exists (
    select 1 from public.allocations a
    join public.production_orders po
      on po.organization_id = a.organization_id and po.id = a.production_order_id
    where po.organization_id = old.organization_id and po.order_item_id = old.id
      and a.status in ('in_progress', 'done')
  ) then
    raise exception 'Item com produção iniciada ou concluída não pode ser removido.';
  end if;
  return old;
end;
$function$;
