-- Formas BRAÇO, LEITO e LATERAL são definidas pelo item do pedido.
-- P01–P04 recebem esses moldes dinamicamente. A exceção é a bancada plana,
-- que permanece reservada para placas sem forma.

create or replace function public.save_mold_position(
  p_org_id uuid,
  p_code text,
  p_status text,
  p_configuration_kind text,
  p_braco_catalog_code text,
  p_leito_catalog_code text,
  p_lateral_catalog_code text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.mold_positions;
  v_configuration text := nullif(trim(p_configuration_kind), '');
begin
  if p_code is null or p_code not in ('P01', 'P02', 'P03', 'P04') then
    raise exception 'Posição inválida.';
  end if;
  if p_status is null or p_status not in ('disponivel', 'em_preparacao', 'em_producao', 'em_manutencao') then
    raise exception 'Status da posição inválido.';
  end if;
  if v_configuration is not null and v_configuration <> 'placa' then
    raise exception 'A posição recebe formas do pedido ou pode ser uma bancada plana para placas.';
  end if;

  select * into v_row
  from public.mold_positions
  where organization_id = p_org_id and code = p_code
  for update;
  if not found then raise exception 'A posição não existe nesta unidade.'; end if;

  if v_row.status is distinct from p_status
    or v_row.configuration_kind is distinct from v_configuration
    or v_row.braco_catalog_code is not null
    or v_row.leito_catalog_code is not null
    or v_row.lateral_catalog_code is not null
    or v_row.notes is distinct from nullif(trim(p_notes), '') then
    update public.mold_positions
    set status = p_status,
        configuration_kind = v_configuration,
        braco_catalog_code = null,
        leito_catalog_code = null,
        lateral_catalog_code = null,
        notes = nullif(trim(p_notes), '')
    where id = v_row.id and organization_id = p_org_id
    returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.validate_allocation_compatibility_and_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_piece_type_id uuid;
  v_position_configuration text;
  v_position_status text;
  v_timezone text;
  v_catalog_code text;
  v_start timestamptz;
  v_end timestamptz;
  v_cast_start timestamptz;
  v_cure_end timestamptz;
begin
  if new.status not in ('planned', 'in_progress') then return new; end if;

  -- Preserva atualizações de linhas legadas ainda sem etapas horárias.
  if tg_op = 'UPDATE'
    and old.occupied_from_at is null and old.occupied_until_at is null
    and new.occupied_from_at is null and new.occupied_until_at is null
    and new.mold_position_id = old.mold_position_id
    and new.scheduled_date = old.scheduled_date
    and new.production_order_id = old.production_order_id
    and new.organization_id = old.organization_id
    and not exists (
      select 1 from public.production_order_steps s
      where s.organization_id = old.organization_id
        and s.production_order_id = old.production_order_id
    ) then
    return new;
  end if;

  if tg_op = 'INSERT' and (new.occupied_from_at is null or new.occupied_until_at is null) then
    raise exception 'Uma nova alocação precisa registrar o início e o fim exatos da ocupação da posição.';
  end if;
  if tg_op = 'UPDATE'
    and old.status not in ('planned', 'in_progress')
    and (new.occupied_from_at is null or new.occupied_until_at is null) then
    raise exception 'Uma alocação reativada precisa registrar o início e o fim exatos da ocupação da posição.';
  end if;

  select pt.piece_kind, pt.id, mp.configuration_kind, mp.status
  into v_kind, v_piece_type_id, v_position_configuration, v_position_status
  from public.production_orders po
  join public.order_items oi
    on oi.id = po.order_item_id and oi.organization_id = po.organization_id
  join public.piece_types pt
    on pt.id = oi.piece_type_id and pt.organization_id = oi.organization_id
  join public.mold_positions mp
    on mp.id = new.mold_position_id and mp.organization_id = new.organization_id
  where po.id = new.production_order_id and po.organization_id = new.organization_id;
  if not found then raise exception 'Produção ou posição não pertence à unidade informada.'; end if;
  if v_position_status = 'em_manutencao' then raise exception 'A posição está em manutenção.'; end if;

  -- A peça carrega a configuração aprovada no pedido. Isso valida a existência
  -- dos moldes sem exigir que a posição tenha uma configuração permanente.
  perform pg_advisory_xact_lock(hashtext(v_piece_type_id::text)::bigint);
  for v_catalog_code in
    select ptm.catalog_code
    from public.piece_type_molds ptm
    where ptm.organization_id = new.organization_id
      and ptm.piece_type_id = v_piece_type_id
    order by ptm.catalog_code
  loop
    perform pg_advisory_xact_lock(hashtext('mold_catalog:' || v_catalog_code)::bigint);
  end loop;

  if v_kind = 'braco' then
    if v_position_configuration = 'placa' then
      raise exception 'A posição está reservada como bancada plana para placas.';
    end if;
    if not exists (
      select 1
      from public.piece_type_molds ptm
      join public.mold_catalog mc on mc.code = ptm.catalog_code
      where ptm.organization_id = new.organization_id
        and ptm.piece_type_id = v_piece_type_id
        and ptm.role = 'braco'
        and mc.mold_type = 'BRACO'
    ) then
      raise exception 'O item do pedido precisa ter uma forma BRAÇO compatível antes da alocação.';
    end if;
  elsif v_kind in ('pilar', 'viga') then
    if v_position_configuration = 'placa' then
      raise exception 'A posição está reservada como bancada plana para placas.';
    end if;
    if not exists (
      select 1
      from public.piece_type_molds bed
      join public.mold_catalog bed_catalog
        on bed_catalog.code = bed.catalog_code and bed_catalog.mold_type = 'LEITO'
      join public.piece_type_molds side
        on side.organization_id = bed.organization_id
        and side.piece_type_id = bed.piece_type_id
        and side.role = 'lateral'
      join public.mold_catalog side_catalog
        on side_catalog.code = side.catalog_code and side_catalog.mold_type = 'LATERAL'
      where bed.organization_id = new.organization_id
        and bed.piece_type_id = v_piece_type_id
        and bed.role = 'leito'
    ) then
      raise exception 'O item do pedido precisa ter LEITO e LATERAL compatíveis antes da alocação.';
    end if;
  elsif v_kind = 'placa' then
    if v_position_configuration is distinct from 'placa' or exists (
      select 1 from public.piece_type_molds ptm
      where ptm.organization_id = new.organization_id
        and ptm.piece_type_id = v_piece_type_id
    ) then
      raise exception 'A placa precisa de uma bancada plana e não pode ter formas vinculadas.';
    end if;
  else
    raise exception 'Classifique o tipo da peça antes de programar sua produção.';
  end if;

  select cast_step.planned_start_at, cure_step.planned_end_at
  into v_cast_start, v_cure_end
  from public.production_order_steps cast_step
  join public.production_order_steps cure_step
    on cure_step.organization_id = cast_step.organization_id
    and cure_step.production_order_id = cast_step.production_order_id
  where cast_step.organization_id = new.organization_id
    and cast_step.production_order_id = new.production_order_id
    and cast_step.step_kind = 'concretagem'
    and cure_step.step_kind = 'cura';
  if v_cast_start is null or v_cure_end is null then
    raise exception 'Planeje concretagem e cura antes de alocar a posição.';
  end if;
  if new.occupied_from_at is null or new.occupied_until_at is null
    or new.occupied_from_at > v_cast_start or new.occupied_until_at < v_cure_end then
    raise exception 'A posição precisa permanecer reservada desde a concretagem até o fim da cura.';
  end if;

  select o.timezone into v_timezone
  from public.organizations o where o.id = new.organization_id;
  v_start := coalesce(new.occupied_from_at, timezone(v_timezone, new.scheduled_date::timestamp));
  v_end := coalesce(new.occupied_until_at, timezone(v_timezone, (new.scheduled_date + 1)::timestamp));
  if v_end <= v_start then raise exception 'O intervalo de ocupação da posição é inválido.'; end if;

  perform pg_advisory_xact_lock(hashtext(new.mold_position_id::text)::bigint);
  if exists (
    select 1
    from public.allocations a
    where a.organization_id = new.organization_id
      and a.mold_position_id = new.mold_position_id
      and a.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and a.status in ('planned', 'in_progress')
      and v_start < coalesce(a.occupied_until_at, timezone(v_timezone, (a.scheduled_date + 1)::timestamp))
      and v_end > coalesce(a.occupied_from_at, timezone(v_timezone, a.scheduled_date::timestamp))
  ) then
    raise exception 'A posição já está ocupada durante o intervalo solicitado.';
  end if;
  return new;
end;
$$;

-- Sobrescreve a RPC da migration 011 para validar o molde em X × Z; Y continua sendo o comprimento e permanece armazenado sem alteração.
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
  v_production_minutes integer;
  v_configured_count integer;
  v_valid_count integer;
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
  if v_piece_kind is null or v_piece_kind not in ('braco', 'pilar', 'viga') then raise exception 'Tipo de peça inválido.'; end if;
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

  select count(cc.constant_key)::integer,
    (count(*) filter (where cc.unit = 'min/un' and cc.numeric_value > 0
      and cc.numeric_value = trunc(cc.numeric_value) and cc.numeric_value <= 2147483647))::integer
  into v_configured_count, v_valid_count
  from (values ('production_minutes_braco'), ('production_minutes_pilar'), ('production_minutes_viga')) required(constant_key)
  left join public.calculation_constants cc
    on cc.organization_id = p_org_id and cc.constant_key = required.constant_key;
  if v_configured_count <> 3 or v_valid_count <> 3 then
    raise exception 'Configure os tempos positivos em min/un para braço, pilar e viga antes do primeiro item.';
  end if;
  select cc.numeric_value::integer into v_production_minutes
  from public.calculation_constants cc
  where cc.organization_id = p_org_id and cc.constant_key = 'production_minutes_' || v_piece_kind
    and cc.unit = 'min/un' and cc.numeric_value > 0
    and cc.numeric_value = trunc(cc.numeric_value) and cc.numeric_value <= 2147483647;
  if v_production_minutes is null
    or nullif(v_piece->>'productionMinutesPerUnit', '')::integer is distinct from v_production_minutes then
    raise exception 'O tempo por unidade mudou; atualize o item e tente novamente.';
  end if;

  if v_piece_kind = 'braco' then
    v_catalog_code := nullif(trim(v_catalogs->>'braco'), '');
    select count(*)::integer into v_catalog_count from public.mold_catalog c
    where c.code = v_catalog_code and c.mold_type = 'BRACO'
      and c.measure_label ~ '^\s*[0-9]+([.][0-9]+)?\s*[xX]\s*[0-9]+([.][0-9]+)?\s*$'
      and (regexp_match(lower(c.measure_label), '^\s*([0-9]+([.][0-9]+)?)\s*x\s*([0-9]+([.][0-9]+)?)\s*$'))[1]::numeric = v_x
      and (regexp_match(lower(c.measure_label), '^\s*([0-9]+([.][0-9]+)?)\s*x\s*([0-9]+([.][0-9]+)?)\s*$'))[3]::numeric = v_z;
    if v_catalog_count <> 1 then raise exception 'As medidas X e Z não correspondem a uma forma fixa de braço do catálogo.'; end if;
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
    v_volume_cm3, v_volume_m3, v_weight_kg, v_production_minutes,
    v_piece_observations, '{}'::jsonb
  );

  if v_piece_kind = 'braco' then
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values (p_org_id, v_piece_id, 'braco', v_catalogs->>'braco');
  else
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
    v_production_minutes, v_sequence, v_item_observations
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

  if jsonb_array_length(v_plans) > 0 then
    v_queue_result := public.commit_planning_queue(p_org_id, v_plans);
    select exists (
      select 1 from jsonb_array_elements(v_plans) plan(value)
      where plan.value->>'orderId' = v_order_id::text
    ) into v_target_planned;
    select result.value into v_target_commit
    from jsonb_array_elements(coalesce(v_queue_result->'orders', '[]'::jsonb)) result(value)
    where result.value->>'orderId' = v_order_id::text;
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
      'committed', true,
      'waitingForPosition', not v_target_planned,
      'plannedUnitCount', coalesce(nullif(v_target_commit->>'unitCount', '')::integer, 0)
    )
  );
end;
$$;


revoke all on function public.save_mold_position(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_mold_position(uuid, text, text, text, text, text, text, text) to service_role;
revoke all on function public.validate_allocation_compatibility_and_overlap() from public, anon, authenticated;
grant execute on function public.validate_allocation_compatibility_and_overlap() to service_role;

revoke all on function public.add_order_piece_item(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_order_piece_item(uuid, jsonb) to service_role;
