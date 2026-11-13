-- Uma etiqueta por unidade pronta. O registro guarda o texto impresso como
-- retrato do pedido concluído, para que edições futuras no catálogo não mudem
-- etiquetas já geradas.
create table public.production_labels (
  production_order_id uuid primary key references public.production_orders(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  label_code text not null,
  order_number text not null,
  piece_code text not null,
  piece_name text not null,
  client_name text not null,
  observations text not null default '',
  generated_at timestamptz not null default now(),
  check (length(label_code) between 1 and 180),
  check (length(observations) <= 500)
);
create index production_labels_order_idx on public.production_labels (organization_id, order_id, label_code);
alter table public.production_labels enable row level security;
revoke all on public.production_labels from public, anon, authenticated;
grant select, insert on public.production_labels to service_role;

-- Idempotente: a atualização repetida de um pedido não duplica as etiquetas.
-- A chamada exige o mesmo estado de conclusão validado para o pedido.
create function public.ensure_order_labels(p_org_id uuid, p_order_id uuid)
returns integer language plpgsql security definer set search_path = '' as $function$
declare
  v_count integer;
begin
  if not exists (
    select 1 from public.orders o
    where o.organization_id = p_org_id and o.id = p_order_id
      and o.status in ('concluido', 'entregue')
  ) or not public.order_all_units_ready(p_org_id, p_order_id) then
    raise exception 'As etiquetas exigem um pedido concluído com todas as unidades prontas.' using errcode = '23514';
  end if;

  insert into public.production_labels (
    production_order_id, organization_id, order_id, label_code,
    order_number, piece_code, piece_name, client_name, observations
  )
  select po.id, po.organization_id, po.order_id,
    left(concat_ws('-', coalesce(nullif(o.order_number, ''), left(o.id::text, 8)),
      'I' || lpad(oi.sequence::text, 2, '0'),
      coalesce(nullif(pt.code, ''), 'PECA'), lpad(po.unit_sequence::text, 3, '0')), 180),
    coalesce(nullif(o.order_number, ''), left(o.id::text, 8)),
    coalesce(nullif(pt.code, ''), 'PECA'), pt.name,
    coalesce(nullif(c.name, ''), 'Cliente não informado'),
    left(concat_ws(E'\n',
      'Pedido: ' || coalesce(nullif(o.order_number, ''), left(o.id::text, 8)),
      case when w.id is not null then 'Obra: ' || concat_ws(' · ', nullif(w.work_number, ''), nullif(w.name, '')) end,
      'Peça: ' || concat_ws(' · ', nullif(pt.code, ''), nullif(pt.name, '')),
      case when pt.dimension_x_cm is not null and pt.dimension_y_cm is not null and pt.dimension_z_cm is not null
        then 'Medidas: ' || pt.dimension_x_cm || ' × ' || pt.dimension_y_cm || ' × ' || pt.dimension_z_cm || ' cm' end,
      case when pt.volume_m3 is not null then 'Volume: ' || pt.volume_m3 || ' m³' end,
      case when pt.weight_kg is not null then 'Peso: ' || pt.weight_kg || ' kg' end,
      case when nullif(o.observations, '') is not null then 'Pedido: ' || o.observations end,
      case when nullif(oi.observations, '') is not null then 'Item: ' || oi.observations end,
      case when nullif(po.notes, '') is not null then 'Produção: ' || po.notes end
    ), 500)
  from public.production_orders po
  join public.orders o on o.id = po.order_id and o.organization_id = po.organization_id
  join public.order_items oi on oi.id = po.order_item_id and oi.organization_id = po.organization_id
  join public.piece_types pt on pt.id = oi.piece_type_id and pt.organization_id = po.organization_id
  left join public.clients c on c.id = o.client_id and c.organization_id = po.organization_id
  left join public.works w on w.id = o.work_id and w.organization_id = po.organization_id
  where po.organization_id = p_org_id and po.order_id = p_order_id and po.status = 'pronta'
  on conflict (production_order_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.ensure_order_labels(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ensure_order_labels(uuid, uuid) to service_role;

create function public.generate_labels_on_order_completion()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.status = 'concluido' and old.status is distinct from new.status then
    perform public.ensure_order_labels(new.organization_id, new.id);
  end if;
  return new;
end;
$function$;
revoke all on function public.generate_labels_on_order_completion() from public, anon, authenticated;
create trigger trg_generate_labels_on_order_completion
after update of status on public.orders
for each row execute function public.generate_labels_on_order_completion();

-- Recolhe pedidos já concluídos antes da instalação desta migration.
do $backfill$
declare v_order record;
begin
  for v_order in select organization_id, id from public.orders
    where status = 'concluido' and public.order_all_units_ready(organization_id, id) loop
    perform public.ensure_order_labels(v_order.organization_id, v_order.id);
  end loop;
end;
$backfill$;
