-- PRELUX · Etapa 4: itens de pedido com placa e orçamento sem reserva.
-- Atualiza a RPC existente sem alterar tabelas, dados ou vínculos de produção.
begin;
create or replace function public.add_order_piece_item(
  p_org_id uuid,
  p_registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid := nullif(p_registration->>'orderId', '')::uuid;
  v_item_id uuid := nullif(p_registration->>'itemId', '')::uuid;
  v_piece_id uuid := nullif(p_registration->>'pieceId', '')::uuid;
  v_item jsonb := p_registration->'item';
  v_piece jsonb := p_registration->'piece';
  v_catalogs jsonb := v_piece->'moldCatalogs';
  v_plans jsonb := p_registration->'plans';
  v_calendar_days jsonb := p_registration->'planningCalendarDays';
  v_order_status public.order_status;
  v_order_number text;
  v_client_id uuid;
  v_start_date date;
  v_due_date date;
  v_piece_code text;
  v_piece_name text;
  v_piece_kind text;
  v_piece_observations text;
  v_item_observations text;
  v_quantity integer;
  v_sequence integer;
  v_expected_sequence integer;
  v_x numeric;
  v_y numeric;
  v_z numeric;
  v_volume_cm3 numeric;
  v_volume_m3 numeric;
  v_weight_kg numeric;
  v_casting_minutes integer;
  v_catalog_count integer;
  v_catalog_code text;
  v_day jsonb;
  v_queue_result jsonb := '{}'::jsonb;
  v_target_commit jsonb;
  v_target_planned boolean := false;
  v_position_codes text[] := array[]::text[];
begin
  if p_org_id is null or p_registration is null
    or jsonb_typeof(p_registration) is distinct from 'object' then
    raise exception 'Envie a unidade e os dados do item em formato válido.';
  end if;
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'Unidade não encontrada.';
  end if;
  if v_order_id is null or v_item_id is null or v_piece_id is null then
    raise exception 'Pedido, item e peça precisam de identificadores válidos.';
  end if;
  if jsonb_typeof(v_item) is distinct from 'object'
    or jsonb_typeof(v_piece) is distinct from 'object'
    or jsonb_typeof(v_catalogs) is distinct from 'object'
    or jsonb_typeof(v_plans) is distinct from 'array'
    or jsonb_typeof(v_calendar_days) is distinct from 'array' then
    raise exception 'Os dados do item, da peça, das formas e do planejamento são inválidos.';
  end if;
  if jsonb_array_length(v_plans) > 1000 or jsonb_array_length(v_calendar_days) > 5000 then
    raise exception 'O item excede os limites de planejamento.';
  end if;

  -- Serializa itens do mesmo pedido para manter a sequência e as quantidades consistentes.
  perform pg_advisory_xact_lock(hashtext(v_order_id::text)::bigint);
  select o.status, o.order_number, o.client_id, o.start_date, o.requested_due_date
  into v_order_status, v_order_number, v_client_id, v_start_date, v_due_date
  from public.orders o
  where o.organization_id = p_org_id and o.id = v_order_id and o.is_active = true
  for update;
  if not found then raise exception 'Pedido não encontrado ou inativo.'; end if;
  if v_order_status in ('cancelado', 'entregue', 'concluido') then
    raise exception 'Não é possível incluir itens em um pedido encerrado.';
  end if;
  if exists (select 1 from public.engineering_projects ep where ep.organization_id = p_org_id and ep.order_id = v_order_id) then
    raise exception 'Este pedido já avançou para Engenharia; inclua os itens antes de criar o projeto.';
  end if;
  if exists (
    select 1 from public.production_orders po
    where po.organization_id = p_org_id and po.order_id = v_order_id
      and po.status in ('in_progress', 'done', 'scrapped')
  ) or exists (
    select 1 from public.production_schedules ps
    where ps.organization_id = p_org_id and ps.order_id = v_order_id
      and ps.status in ('in_progress', 'done')
  ) then
    raise exception 'Não é possível incluir itens depois do início da produção.';
  end if;

  select coalesce(max(oi.sequence), 0) + 1 into v_expected_sequence
  from public.order_items oi where oi.organization_id = p_org_id and oi.order_id = v_order_id;
  v_sequence := nullif(p_registration->>'sequence', '')::integer;
  if v_sequence is distinct from v_expected_sequence then
    raise exception 'A lista de itens mudou; atualize e tente salvar novamente.';
  end if;
  v_quantity := nullif(v_item->>'quantity', '')::integer;
  if v_quantity is null or v_quantity < 1 then raise exception 'Informe uma quantidade inteira maior que zero.'; end if;

  v_piece_code := upper(nullif(trim(v_piece->>'code'), ''));
  v_piece_name := nullif(trim(v_piece->>'name'), '');
  v_piece_kind := nullif(trim(v_piece->>'pieceKind'), '');
  v_piece_observations := nullif(trim(v_piece->>'observations'), '');
  v_item_observations := nullif(trim(v_item->>'observations'), '');
  v_x := nullif(v_piece->>'dimensionXcm', '')::numeric;
  v_y := nullif(v_piece->>'dimensionYcm', '')::numeric;
  v_z := nullif(v_piece->>'dimensionZcm', '')::numeric;
  if v_piece_code is null or length(v_piece_code) > 60 or v_piece_name is null or length(v_piece_name) > 180 then
    raise exception 'Informe código e nome válidos para a peça.';
  end if;
  if v_piece_kind is null or v_piece_kind not in ('braco', 'pilar', 'viga', 'placa') then raise exception 'Tipo de peça inválido.'; end if;
  if v_x is null or v_y is null or v_z is null or least(v_x, v_y, v_z) <= 0
    or greatest(v_x, v_y, v_z) > 1000000 then
    raise exception 'Informe X, Y e Z positivos em centímetros.';
  end if;
  if exists (select 1 from public.piece_types pt where pt.organization_id = p_org_id and upper(pt.code) = v_piece_code) then
    raise exception 'Já existe uma peça com esse código nesta unidade.';
  end if;

  -- O banco recalcula os indicadores; não confia nos números enviados pela tela.
  v_volume_cm3 := v_x * v_y * v_z;
  v_volume_m3 := v_volume_cm3 / 1000000;
  v_weight_kg := v_volume_cm3 * 2.5 / 1000;

  -- A carga de concretagem alimenta a capacidade do dia. O tempo total da
  -- peça vem das etapas concretagem, cura e acabamento; a preparação da forma
  -- só antecede a concretagem quando a montagem ainda não está pronta.
  select cc.numeric_value::integer into v_casting_minutes
  from public.calculation_constants cc
  where cc.organization_id = p_org_id
    and cc.constant_key = 'casting_duration_minutes'
    and cc.unit = 'min'
    and cc.numeric_value > 0
    and cc.numeric_value = trunc(cc.numeric_value)
    and cc.numeric_value <= 2147483647;
  if v_casting_minutes is null then
    raise exception 'Configure a duração positiva da concretagem em minutos para esta unidade.';
  end if;

  if v_piece_kind = 'braco' then
    v_catalog_code := nullif(trim(v_catalogs->>'braco'), '');
    select count(*)::integer into v_catalog_count from public.mold_catalog c
    where c.code = v_catalog_code and c.mold_type = 'BRACO'
      and c.measure_label ~ '^\s*[0-9]+([.][0-9]+)?\s*[xX]\s*[0-9]+([.][0-9]+)?\s*$'
      and (regexp_match(lower(c.measure_label), '^\s*([0-9]+([.][0-9]+)?)\s*x\s*([0-9]+([.][0-9]+)?)\s*$'))[1]::numeric = v_x
      and (regexp_match(lower(c.measure_label), '^\s*([0-9]+([.][0-9]+)?)\s*x\s*([0-9]+([.][0-9]+)?)\s*$'))[3]::numeric = v_z;
    if v_catalog_count <> 1 then raise exception 'As medidas X e Z não correspondem a uma forma fixa de braço do catálogo.'; end if;
  elsif v_piece_kind = 'placa' then
    if nullif(trim(v_catalogs->>'braco'), '') is not null
      or nullif(trim(v_catalogs->>'leito'), '') is not null
      or nullif(trim(v_catalogs->>'lateral'), '') is not null then
      raise exception 'Placa não pode exigir forma do catálogo.';
    end if;
  else
    select count(*)::integer into v_catalog_count from public.mold_catalog c
    where (c.code = nullif(trim(v_catalogs->>'leito'), '') and c.mold_type = 'LEITO'
        and c.measure_label ~ '^\s*[0-9]+([.][0-9]+)?\s*$' and trim(c.measure_label)::numeric = v_x)
       or (c.code = nullif(trim(v_catalogs->>'lateral'), '') and c.mold_type = 'LATERAL'
        and c.measure_label ~ '^\s*[0-9]+([.][0-9]+)?\s*$' and trim(c.measure_label)::numeric = v_z);
    if v_catalog_count <> 2 then raise exception 'As medidas X e Z não correspondem à combinação LEITO × LATERAL do catálogo.'; end if;
  end if;

  insert into public.piece_types (
    id, organization_id, code, name, piece_kind,
    dimension_x_cm, dimension_y_cm, dimension_z_cm, dimensions,
    volume_cm3, volume_m3, weight_kg, production_minutes_per_unit,
    observations, custom_fields
  ) values (
    v_piece_id, p_org_id, v_piece_code, v_piece_name, v_piece_kind,
    v_x, v_y, v_z, format('%s x %s x %s cm', v_x, v_y, v_z),
    v_volume_cm3, v_volume_m3, v_weight_kg, v_casting_minutes,
    v_piece_observations, '{}'::jsonb
  );

  if v_piece_kind = 'braco' then
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values (p_org_id, v_piece_id, 'braco', v_catalogs->>'braco');
  elsif v_piece_kind in ('pilar', 'viga') then
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values
      (p_org_id, v_piece_id, 'leito', v_catalogs->>'leito'),
      (p_org_id, v_piece_id, 'lateral', v_catalogs->>'lateral');
  end if;
insert into public.order_items (
    id, organization_id, order_id, piece_type_id, quantity,
    production_minutes_snapshot, sequence, observations
  ) values (
    v_item_id, p_org_id, v_order_id, v_piece_id, v_quantity,
    v_casting_minutes, v_sequence, v_item_observations
  );

  for v_day in select value from jsonb_array_elements(v_calendar_days)
  loop
    insert into public.calendar_days (
      organization_id, date, is_working, capacity_minutes, source, exception_id, note, generated_at
    ) values (
      p_org_id, (v_day->>'date')::date, (v_day->>'is_working')::boolean,
      (v_day->>'capacity_minutes')::integer, coalesce(nullif(v_day->>'source', ''), 'regra'),
      nullif(v_day->>'exception_id', '')::uuid, nullif(trim(v_day->>'note'), ''), now()
    ) on conflict (organization_id, date) do update set
      is_working = excluded.is_working,
      capacity_minutes = excluded.capacity_minutes,
      source = excluded.source,
      exception_id = excluded.exception_id,
      note = excluded.note,
      generated_at = excluded.generated_at;
  end loop;

  if jsonb_array_length(v_plans) > 0 and v_order_status <> 'orcamento' then
    v_queue_result := public.commit_planning_queue(p_org_id, v_plans);
    select exists (
      select 1 from jsonb_array_elements(v_plans) plan(value)
      where plan.value->>'orderId' = v_order_id::text
    ) into v_target_planned;
    select result.value into v_target_commit
    from jsonb_array_elements(coalesce(v_queue_result->'orders', '[]'::jsonb)) result(value)
    where result.value->>'orderId' = v_order_id::text;
  end if;

  if v_order_status = 'orcamento' then
    -- O orçamento pode ser simulado, mas não conserva posição reservada.
    perform public.commit_order_plan(p_org_id, v_order_id, jsonb_build_object('units', '[]'::jsonb));
    update public.orders
    set planned_start_date = null, planned_end_date = null, forecast_end_date = null
    where organization_id = p_org_id and id = v_order_id;
  end if;

  select coalesce(array_agg(distinct mp.code order by mp.code), array[]::text[])
  into v_position_codes
  from public.production_orders po
  join public.allocations a on a.organization_id = po.organization_id and a.production_order_id = po.id
  join public.mold_positions mp on mp.organization_id = a.organization_id and mp.id = a.mold_position_id
  where po.organization_id = p_org_id and po.order_id = v_order_id;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (
    p_org_id, 'order_items', v_item_id, 'order_item_received', 'acesso-publico',
    jsonb_build_object('orderId', v_order_id, 'orderNumber', v_order_number,
      'pieceId', v_piece_id, 'sequence', v_sequence, 'positionCodes', to_jsonb(v_position_codes))
  );

  return jsonb_build_object(
    'orderId', v_order_id, 'orderNumber', v_order_number,
    'itemId', v_item_id, 'pieceId', v_piece_id, 'sequence', v_sequence,
    'positionCodes', to_jsonb(v_position_codes),
    'planning', jsonb_build_object(
      'committed', v_target_planned,
      'simulatedOnly', v_order_status = 'orcamento',
      'waitingForPosition', case when v_order_status = 'orcamento' then false else not v_target_planned end,
      'plannedUnitCount', coalesce(nullif(v_target_commit->>'unitCount', '')::integer, 0)
    )
  );
end;
$$;
revoke all on function public.add_order_piece_item(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_order_piece_item(uuid, jsonb) to service_role;

commit;
