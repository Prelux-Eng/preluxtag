-- Etapa 5: alocação cancelada não define a forma física montada.
create or replace function public.factory_installed_form_by_position(p_org_id uuid)
returns table (mold_position_id uuid, mold_catalog_codes text[])
language sql
stable
security invoker
set search_path = ''
as $function$
  select distinct on (a.mold_position_id)
    a.mold_position_id, a.mold_catalog_codes
  from public.allocations a
  join public.mold_positions mp
    on mp.organization_id = a.organization_id and mp.id = a.mold_position_id
  join public.production_orders po
    on po.organization_id = a.organization_id and po.id = a.production_order_id
  where a.organization_id = p_org_id
    and a.status <> 'cancelled'
    and pg_catalog.cardinality(a.mold_catalog_codes) > 0
    and (
      a.status = 'done' or po.status = 'done'
      or exists (
        select 1 from public.production_order_steps s
        where s.organization_id = po.organization_id and s.production_order_id = po.id
          and s.step_kind = 'concretagem' and s.status = 'done'
      )
    )
    and (mp.form_reset_at is null
      or coalesce(a.occupied_until_at, a.scheduled_date::timestamptz) > mp.form_reset_at)
  order by a.mold_position_id,
    coalesce(a.occupied_until_at, a.scheduled_date::timestamptz) desc, a.id desc;
$function$;

revoke all on function public.factory_installed_form_by_position(uuid) from public, anon, authenticated;
grant execute on function public.factory_installed_form_by_position(uuid) to service_role;
