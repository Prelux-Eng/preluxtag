-- Etapa 5: mantém a etiqueta atual, seu histórico de versões e cada pedido de
-- emissão/reimpressão. O nome do operador é autodeclarado porque a aplicação
-- ainda funciona sem autenticação.

alter table public.production_labels
  add column if not exists version_number integer not null default 1;

create table public.production_label_versions (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  production_order_id uuid not null references public.production_orders(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  label_code text not null check (length(label_code) between 1 and 180),
  order_number text not null,
  piece_code text not null,
  piece_name text not null,
  client_name text not null,
  observations text not null default '' check (length(observations) <= 500),
  generated_at timestamptz not null,
  primary key (organization_id, production_order_id, version_number)
);

-- A etiqueta atual já é um retrato usado em produção. Ele passa a ser a
-- versão 1, sem alterar o conteúdo já armazenado.
insert into public.production_label_versions (
  organization_id, production_order_id, order_id, version_number,
  label_code, order_number, piece_code, piece_name, client_name,
  observations, generated_at
)
select organization_id, production_order_id, order_id, version_number,
  label_code, order_number, piece_code, piece_name, client_name,
  observations, generated_at
from public.production_labels
on conflict (organization_id, production_order_id, version_number) do nothing;

alter table public.production_labels
  add constraint production_labels_version_number_check check (version_number > 0);
alter table public.production_labels
  add constraint production_labels_current_version_unique
  unique (organization_id, production_order_id, version_number);
alter table public.production_labels
  add constraint production_labels_current_version_fk
  foreign key (organization_id, production_order_id, version_number)
  references public.production_label_versions (organization_id, production_order_id, version_number)
  on delete restrict;

create table public.production_label_print_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  production_order_id uuid not null,
  version_number integer not null,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  printed_by text not null check (length(btrim(printed_by)) between 1 and 120),
  requested_at timestamptz not null default now(),
  foreign key (organization_id, production_order_id, version_number)
    references public.production_label_versions (organization_id, production_order_id, version_number)
    on delete cascade,
  unique (organization_id, idempotency_key, production_order_id)
);
create index production_label_print_events_history_idx
  on public.production_label_print_events (organization_id, production_order_id, requested_at desc);

alter table public.production_labels enable row level security;
alter table public.production_label_versions enable row level security;
alter table public.production_label_print_events enable row level security;
revoke all on public.production_labels, public.production_label_versions,
  public.production_label_print_events from public, anon, authenticated;
grant select, insert, update on public.production_labels to service_role;
grant select, insert on public.production_label_versions,
  public.production_label_print_events to service_role;

-- Cria ou sincroniza um retrato por unidade. Repetir a chamada com os mesmos
-- dados não cria versão nova; uma mudança real de conteúdo cria N + 1.
create or replace function public.ensure_order_labels(p_org_id uuid, p_order_id uuid)
returns integer language plpgsql security definer set search_path = '' as $function$
declare
  v_order public.orders;
  v_label record;
  v_current public.production_labels;
  v_version integer;
  v_count integer := 0;
begin
  select * into v_order from public.orders o
  where o.organization_id = p_org_id and o.id = p_order_id
  for update;
  if not found or v_order.status not in ('concluido', 'entregue')
    or not public.order_all_units_ready(p_org_id, p_order_id) then
    raise exception 'As etiquetas exigem um pedido concluído com todas as unidades prontas.' using errcode = '23514';
  end if;

  for v_label in
    select po.id as production_order_id, po.organization_id, po.order_id,
      left(concat_ws('-', coalesce(nullif(o.order_number, ''), left(o.id::text, 8)),
        'I' || lpad(oi.sequence::text, 2, '0'),
        coalesce(nullif(pt.code, ''), 'PECA'), lpad(po.unit_sequence::text, 3, '0')), 180) as label_code,
      coalesce(nullif(o.order_number, ''), left(o.id::text, 8)) as order_number,
      coalesce(nullif(pt.code, ''), 'PECA') as piece_code,
      pt.name as piece_name,
      coalesce(nullif(c.name, ''), 'Cliente não informado') as client_name,
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
      ), 500) as observations
    from public.production_orders po
    join public.orders o on o.id = po.order_id and o.organization_id = po.organization_id
    join public.order_items oi on oi.id = po.order_item_id and oi.organization_id = po.organization_id
    join public.piece_types pt on pt.id = oi.piece_type_id and pt.organization_id = po.organization_id
    left join public.clients c on c.id = o.client_id and c.organization_id = po.organization_id
    left join public.works w on w.id = o.work_id and w.organization_id = po.organization_id
    where po.organization_id = p_org_id and po.order_id = p_order_id and po.status = 'pronta'
    order by po.id
  loop
    select * into v_current from public.production_labels l
    where l.production_order_id = v_label.production_order_id
      and l.organization_id = p_org_id
    for update;

    if not found then
      v_version := 1;
      insert into public.production_label_versions (
        organization_id, production_order_id, order_id, version_number,
        label_code, order_number, piece_code, piece_name, client_name,
        observations, generated_at
      ) values (
        p_org_id, v_label.production_order_id, v_label.order_id, v_version,
        v_label.label_code, v_label.order_number, v_label.piece_code,
        v_label.piece_name, v_label.client_name, v_label.observations, now()
      );
      insert into public.production_labels (
        production_order_id, organization_id, order_id, label_code,
        order_number, piece_code, piece_name, client_name, observations,
        version_number, generated_at
      ) values (
        v_label.production_order_id, p_org_id, v_label.order_id,
        v_label.label_code, v_label.order_number, v_label.piece_code,
        v_label.piece_name, v_label.client_name, v_label.observations,
        v_version, now()
      );
      v_count := v_count + 1;
    elsif row(v_current.order_id, v_current.label_code, v_current.order_number,
        v_current.piece_code, v_current.piece_name, v_current.client_name,
        v_current.observations)
      is distinct from row(v_label.order_id, v_label.label_code, v_label.order_number,
        v_label.piece_code, v_label.piece_name, v_label.client_name,
        v_label.observations) then
      v_version := v_current.version_number + 1;
      insert into public.production_label_versions (
        organization_id, production_order_id, order_id, version_number,
        label_code, order_number, piece_code, piece_name, client_name,
        observations, generated_at
      ) values (
        p_org_id, v_label.production_order_id, v_label.order_id, v_version,
        v_label.label_code, v_label.order_number, v_label.piece_code,
        v_label.piece_name, v_label.client_name, v_label.observations, now()
      );
      update public.production_labels set
        order_id = v_label.order_id,
        label_code = v_label.label_code,
        order_number = v_label.order_number,
        piece_code = v_label.piece_code,
        piece_name = v_label.piece_name,
        client_name = v_label.client_name,
        observations = v_label.observations,
        version_number = v_version,
        generated_at = now()
      where production_order_id = v_label.production_order_id
        and organization_id = p_org_id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$function$;
revoke all on function public.ensure_order_labels(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ensure_order_labels(uuid, uuid) to service_role;

-- Registra cada unidade solicitada, mantendo a operação idempotente para que
-- uma repetição da mesma requisição não produza duplicatas no histórico.
create function public.record_production_label_prints(
  p_org_id uuid,
  p_labels jsonb,
  p_idempotency_key uuid,
  p_actor_label text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_entry jsonb;
  v_unit_id uuid;
  v_version integer;
  v_order_id uuid;
  v_candidate_order_id uuid;
  v_ids uuid[] := array[]::uuid[];
  v_versions integer[] := array[]::integer[];
  v_actor text := btrim(coalesce(p_actor_label, ''));
  v_fingerprint text;
  v_existing_count integer;
  v_existing_fingerprint text;
  v_events jsonb;
begin
  if p_org_id is null or p_idempotency_key is null then
    raise exception 'Unidade e chave da solicitação são obrigatórias.' using errcode = '22023';
  end if;
  if coalesce(pg_catalog.jsonb_typeof(p_labels), '') <> 'array' then
    raise exception 'Informe uma lista de etiquetas válida.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_labels) not between 1 and 5000 then
    raise exception 'Informe entre 1 e 5.000 etiquetas.' using errcode = '22023';
  end if;
  if pg_catalog.length(v_actor) not between 1 and 120 then
    raise exception 'Informe o nome de quem está solicitando a impressão (máximo de 120 caracteres).' using errcode = '22023';
  end if;

  for v_entry in select value from pg_catalog.jsonb_array_elements(p_labels)
  loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
      or coalesce(v_entry->>'productionOrderId', '') = ''
      or coalesce(v_entry->>'versionNumber', '') !~ '^[1-9][0-9]*$' then
      raise exception 'Uma das etiquetas solicitadas é inválida.' using errcode = '22023';
    end if;
    v_unit_id := (v_entry->>'productionOrderId')::uuid;
    v_version := (v_entry->>'versionNumber')::integer;
    if v_unit_id = any(v_ids) then
      raise exception 'A lista contém a mesma unidade mais de uma vez.' using errcode = '22023';
    end if;
    v_ids := pg_catalog.array_append(v_ids, v_unit_id);
    v_versions := pg_catalog.array_append(v_versions, v_version);
  end loop;

  select pg_catalog.md5(p_org_id::text || E'\n' || v_actor || E'\n' ||
    coalesce(pg_catalog.string_agg(x.unit_id::text || ':' || x.version_number::text,
      E'\n' order by x.unit_id), ''))
  into v_fingerprint
  from pg_catalog.unnest(v_ids, v_versions) as x(unit_id, version_number);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_org_id::text || ':' || p_idempotency_key::text, 0)
  );

  -- Usa a mesma ordem de bloqueios da geração: pedido, depois unidade e
  -- etiqueta. Isso evita imprimir uma versão antiga e reduz risco de deadlock.
  for v_candidate_order_id in
    select distinct l.order_id
    from pg_catalog.unnest(v_ids, v_versions) as x(unit_id, version_number)
    join public.production_labels l on l.production_order_id = x.unit_id
      and l.version_number = x.version_number and l.organization_id = p_org_id
    order by l.order_id
  loop
    select o.id into v_order_id from public.orders o
    where o.organization_id = p_org_id and o.id = v_candidate_order_id
      and o.status in ('concluido', 'entregue')
    for share;
    if not found or not public.order_all_units_ready(p_org_id, v_candidate_order_id) then
      raise exception 'As etiquetas exigem um pedido concluído com todas as unidades prontas.' using errcode = '23514';
    end if;
  end loop;

  -- Mantém cada versão e unidade bloqueadas até terminar o registro.
  for v_entry in
    select pg_catalog.jsonb_build_object('productionOrderId', x.unit_id,
      'versionNumber', x.version_number)
    from pg_catalog.unnest(v_ids, v_versions) as x(unit_id, version_number)
    order by x.unit_id
  loop
    v_unit_id := (v_entry->>'productionOrderId')::uuid;
    v_version := (v_entry->>'versionNumber')::integer;
    select l.order_id into v_order_id
    from public.production_labels l
    join public.production_orders po on po.id = l.production_order_id
      and po.organization_id = l.organization_id
    where l.organization_id = p_org_id and l.production_order_id = v_unit_id
      and l.version_number = v_version and po.status = 'pronta'
    for share of po, l;
    if not found then
      raise exception 'A etiqueta não é a versão atual de uma unidade pronta de pedido concluído.' using errcode = '23514';
    end if;
  end loop;

  select count(*), min(e.request_fingerprint)
    into v_existing_count, v_existing_fingerprint
  from public.production_label_print_events e
  where e.organization_id = p_org_id and e.idempotency_key = p_idempotency_key;
  if v_existing_count > 0 then
    if v_existing_count <> pg_catalog.cardinality(v_ids)
      or v_existing_fingerprint is distinct from v_fingerprint
      or exists (select 1 from public.production_label_print_events e
        where e.organization_id = p_org_id and e.idempotency_key = p_idempotency_key
          and e.request_fingerprint is distinct from v_fingerprint) then
      raise exception 'A chave desta solicitação já foi usada com outro conteúdo.' using errcode = '23505';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.production_order_id), '[]'::jsonb)
      into v_events
    from public.production_label_print_events e
    where e.organization_id = p_org_id and e.idempotency_key = p_idempotency_key;
    return pg_catalog.jsonb_build_object('idempotent', true, 'events', v_events);
  end if;

  for v_entry in
    select pg_catalog.jsonb_build_object('productionOrderId', x.unit_id,
      'versionNumber', x.version_number)
    from pg_catalog.unnest(v_ids, v_versions) as x(unit_id, version_number)
    order by x.unit_id
  loop
    v_unit_id := (v_entry->>'productionOrderId')::uuid;
    v_version := (v_entry->>'versionNumber')::integer;
    insert into public.production_label_print_events (
      organization_id, production_order_id, version_number,
      idempotency_key, request_fingerprint, printed_by
    ) values (p_org_id, v_unit_id, v_version,
      p_idempotency_key, v_fingerprint, v_actor);
  end loop;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.production_order_id), '[]'::jsonb)
    into v_events
  from public.production_label_print_events e
  where e.organization_id = p_org_id and e.idempotency_key = p_idempotency_key;
  return pg_catalog.jsonb_build_object('idempotent', false, 'events', v_events);
end;
$function$;
revoke all on function public.record_production_label_prints(uuid, jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_production_label_prints(uuid, jsonb, uuid, text)
  to service_role;

-- A exclusão autorizada de pedido já arquiva o histórico completo. Inclui os
-- novos retratos e eventos antes que as cascatas removam as unidades.
create or replace function public.delete_order_with_history(p_org_id uuid, p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_order public.orders;
  v_had_plan boolean := false;
  v_snapshot jsonb;
  v_description text;
begin
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
    'labelVersions', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v)), '[]'::jsonb)
      from public.production_label_versions v where v.organization_id = p_org_id and v.order_id = p_order_id),
    'labelPrintEvents', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e)), '[]'::jsonb)
      from public.production_label_print_events e join public.production_label_versions v
        on v.organization_id = e.organization_id
        and v.production_order_id = e.production_order_id and v.version_number = e.version_number
      where e.organization_id = p_org_id and v.order_id = p_order_id),
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

  delete from public.resource_allocations ra using public.order_items oi
    where ra.organization_id = p_org_id and oi.organization_id = p_org_id
      and ra.order_item_id = oi.id and oi.order_id = p_order_id;
  delete from public.production_labels l
    where l.organization_id = p_org_id and l.order_id = p_order_id;
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
