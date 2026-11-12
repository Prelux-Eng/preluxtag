-- Remove do cadastro o cálculo composto e mantém volume/peso por X x Y x Z.
-- A migration 009 é histórica; esta função a substitui sem alterar essa migration.
create or replace function public.create_order_piece_registration(
  p_org_id uuid,
  p_registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work jsonb := p_registration->'work';
  v_order jsonb := p_registration->'order';
  v_item jsonb := p_registration->'item';
  v_piece jsonb := p_registration->'piece';
  v_plans jsonb := p_registration->'plans';
  v_calendar_days jsonb := p_registration->'planningCalendarDays';
  v_mold_catalogs jsonb := v_piece->'moldCatalogs';
  v_order_id uuid := nullif(p_registration->>'orderId', '')::uuid;
  v_item_id uuid := nullif(p_registration->>'itemId', '')::uuid;
  v_piece_id uuid := nullif(p_registration->>'pieceId', '')::uuid;
  v_work_number text;
  v_work_name text;
  v_client_name text;
  v_address text;
  v_responsible_name text;
  v_work_start_date date;
  v_work_due_date date;
  v_order_start_date date;
  v_order_due_date date;
  v_order_status public.order_status;
  v_client_id uuid;
  v_work_id uuid;
  v_order_number text;
  v_next_order_number numeric;
  v_piece_code text;
  v_piece_name text;
  v_piece_kind text;
  v_piece_observations text;
  v_item_observations text;
  v_order_observations text;
  v_quantity integer;
  v_sequence integer;
  v_x numeric;
  v_y numeric;
  v_z numeric;
  v_volume_cm3 numeric := 0;
  v_volume_m3 numeric;
  v_weight_kg numeric;
  v_production_minutes integer;
  v_configured_kind_count integer;
  v_valid_production_minutes_count integer;
  v_catalog_count integer;
  v_catalog_code text;
  v_day jsonb;
  v_queue_result jsonb := '{}'::jsonb;
  v_target_commit jsonb;
  v_target_was_planned boolean := false;
  v_position_codes text[] := array[]::text[];
begin
  if p_org_id is null or p_registration is null or jsonb_typeof(p_registration) is distinct from 'object' then
    raise exception 'Envie a unidade e os dados do cadastro em formato valido.';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org_id) then
    raise exception 'Unidade nao encontrada.';
  end if;

  -- Serializa a geracao de pedidos e o reuso/criacao da obra e do cliente.
  perform pg_advisory_xact_lock(hashtext(p_org_id::text), hashtext('create_order_piece_registration'));

  if jsonb_typeof(v_work) is distinct from 'object'
    or jsonb_typeof(v_order) is distinct from 'object'
    or jsonb_typeof(v_item) is distinct from 'object'
    or jsonb_typeof(v_piece) is distinct from 'object' then
    raise exception 'Obra, pedido, item e peca sao obrigatorios.';
  end if;
  if jsonb_typeof(v_plans) is distinct from 'array'
    or jsonb_typeof(v_calendar_days) is distinct from 'array' then
    raise exception 'Planos e dias do calendario precisam ser listas.';
  end if;
  if jsonb_array_length(v_plans) > 1000 or jsonb_array_length(v_calendar_days) > 5000 then
    raise exception 'O cadastro excede o limite de planos ou dias de calendario.';
  end if;
  if v_order_id is null or v_item_id is null or v_piece_id is null then
    raise exception 'Os identificadores do pedido, item e peca sao obrigatorios.';
  end if;

  v_work_number := upper(nullif(trim(v_work->>'workNumber'), ''));
  v_work_name := nullif(trim(v_work->>'name'), '');
  v_client_name := nullif(trim(v_work->>'clientName'), '');
  v_address := nullif(trim(v_work->>'address'), '');
  v_responsible_name := nullif(trim(v_work->>'responsibleName'), '');
  v_work_start_date := nullif(v_work->>'startDate', '')::date;
  v_work_due_date := nullif(v_work->>'requestedDueDate', '')::date;
  v_order_start_date := nullif(v_order->>'startDate', '')::date;
  v_order_due_date := nullif(v_order->>'requestedDueDate', '')::date;
  v_order_status := coalesce(nullif(v_order->>'status', ''), 'orcamento')::public.order_status;

  if v_work_number is null or length(v_work_number) > 80
    or v_work_name is null or length(v_work_name) > 180
    or v_client_name is null or length(v_client_name) > 180
    or v_address is null or length(v_address) > 300
    or v_responsible_name is null or length(v_responsible_name) > 180
    or v_work_start_date is null then
    raise exception 'Preencha numero, nome, cliente, endereco, responsavel e inicio da obra.';
  end if;
  if v_work_due_date is null or v_work_due_date < v_work_start_date then
    raise exception 'O prazo da obra deve ser informado e nao pode anteceder seu inicio.';
  end if;
  if v_order_start_date is distinct from v_work_start_date
    or v_order_due_date is distinct from v_work_due_date then
    raise exception 'As datas do pedido precisam corresponder as datas informadas para a obra.';
  end if;
  if v_order_status <> 'orcamento'::public.order_status then
    raise exception 'Um novo pedido deste cadastro deve iniciar como orcamento.';
  end if;

  v_quantity := nullif(v_item->>'quantity', '')::integer;
  v_sequence := coalesce(nullif(v_item->>'sequence', '')::integer, 1);
  if v_quantity is null or v_quantity < 1 or v_sequence <> 1 then
    raise exception 'Informe quantidade positiva e sequencia 1 para o novo item.';
  end if;

  v_piece_code := upper(nullif(trim(v_piece->>'code'), ''));
  v_piece_name := nullif(trim(v_piece->>'name'), '');
  v_piece_kind := nullif(trim(v_piece->>'pieceKind'), '');
  v_piece_observations := nullif(trim(v_piece->>'observations'), '');
  v_item_observations := nullif(trim(v_item->>'observations'), '');
  v_order_observations := nullif(trim(v_order->>'observations'), '');
  v_x := nullif(v_piece->>'dimensionXcm', '')::numeric;
  v_y := nullif(v_piece->>'dimensionYcm', '')::numeric;
  v_z := nullif(v_piece->>'dimensionZcm', '')::numeric;
  if v_piece_code is null or length(v_piece_code) > 60
    or v_piece_name is null or length(v_piece_name) > 180 then
    raise exception 'Informe codigo e nome validos para a peca.';
  end if;
  if v_piece_kind is null or v_piece_kind not in ('braco', 'pilar', 'viga') then
    raise exception 'O tipo da peca deve ser braco, pilar ou viga.';
  end if;
  if v_x is null or v_y is null or v_z is null
    or least(v_x, v_y, v_z) <= 0 or greatest(v_x, v_y, v_z) > 1000000 then
    raise exception 'Informe largura, comprimento e espessura positivos em centimetros.';
  end if;
  -- Recalcula o volume como prisma X x Y x Z; medidas informadas em centimetros.
  v_volume_cm3 := v_x * v_y * v_z;
  v_volume_m3 := v_volume_cm3 / 1000000;
  v_weight_kg := v_volume_cm3 * 2.5 / 1000;

  -- Exige os tres tempos de producao por tipo e preserva o snapshot do plano.
  select count(cc.constant_key)::integer,
    (count(*) filter (where cc.unit = 'min/un' and cc.numeric_value > 0
      and cc.numeric_value = trunc(cc.numeric_value)
      and cc.numeric_value <= 2147483647))::integer
  into v_configured_kind_count, v_valid_production_minutes_count
  from (values
    ('production_minutes_braco'),
    ('production_minutes_pilar'),
    ('production_minutes_viga')
  ) as required(constant_key)
  left join public.calculation_constants cc
    on cc.organization_id = p_org_id and cc.constant_key = required.constant_key;
  if v_configured_kind_count <> 3 or v_valid_production_minutes_count <> 3 then
    raise exception 'Configure os tempos positivos em min/un para braco, pilar e viga antes do cadastro.';
  end if;
  select cc.numeric_value::integer into v_production_minutes
  from public.calculation_constants cc
  where cc.organization_id = p_org_id
    and cc.constant_key = 'production_minutes_' || v_piece_kind
    and cc.unit = 'min/un'
    and cc.numeric_value > 0
    and cc.numeric_value = trunc(cc.numeric_value)
    and cc.numeric_value <= 2147483647;
  if v_production_minutes is null
    or nullif(v_piece->>'productionMinutesPerUnit', '')::integer is distinct from v_production_minutes then
    raise exception 'O tempo por unidade mudou; atualize o cadastro e tente novamente.';
  end if;

  if jsonb_typeof(v_mold_catalogs) is distinct from 'object' then
    raise exception 'Selecione a forma compativel com a peca.';
  end if;
  if v_piece_kind = 'braco' then
    v_catalog_code := nullif(trim(v_mold_catalogs->>'braco'), '');
    select count(*)::integer into v_catalog_count
    from public.mold_catalog c where c.code = v_catalog_code and c.mold_type = 'BRACO';
    if v_catalog_count <> 1 then
      raise exception 'Braco exige uma forma fixa BRACO valida do catalogo.';
    end if;
  else
    if nullif(trim(v_mold_catalogs->>'braco'), '') is not null then
      raise exception 'A forma fixa BRACO so e permitida para peca do tipo braco.';
    end if;
    select count(*)::integer into v_catalog_count
    from (values
      ('LEITO'::text, nullif(trim(v_mold_catalogs->>'leito'), '')),
      ('LATERAL'::text, nullif(trim(v_mold_catalogs->>'lateral'), ''))
    ) as required(mold_type, code)
    join public.mold_catalog c on c.mold_type = required.mold_type and c.code = required.code;
    if v_catalog_count <> 2 then
      raise exception 'Pilar e viga exigem formas LEITO e LATERAL validas do catalogo.';
    end if;
  end if;

  -- Usa ou cria o cliente sem introduzir uma tabela de clientes paralela.
  select c.id into v_client_id
  from public.clients c
  where c.organization_id = p_org_id and c.is_active = true
    and lower(trim(c.name)) = lower(v_client_name)
  order by c.created_at, c.id
  limit 1
  for update;
  if v_client_id is null then
    insert into public.clients (organization_id, name)
    values (p_org_id, v_client_name)
    returning id into v_client_id;
  end if;

  -- Reutiliza a obra pelo numero; a trigger da migration 008 sincroniza pedidos existentes.
  select w.id into v_work_id
  from public.works w
  where w.organization_id = p_org_id and w.work_number = v_work_number
  for update;
  if v_work_id is null then
    insert into public.works (
      organization_id, work_number, name, client_id, address, responsible_name,
      start_date, requested_due_date, status
    ) values (
      p_org_id, v_work_number, v_work_name, v_client_id, v_address, v_responsible_name,
      v_work_start_date, v_work_due_date, 'planejamento'
    ) returning id into v_work_id;
  else
    update public.works set
      name = v_work_name,
      client_id = v_client_id,
      address = v_address,
      responsible_name = v_responsible_name,
      start_date = v_work_start_date,
      requested_due_date = v_work_due_date,
      is_active = true
    where id = v_work_id and organization_id = p_org_id;
  end if;

  select coalesce(max(substring(o.order_number from 5)::numeric), 0) + 1
  into v_next_order_number
  from public.orders o
  where o.organization_id = p_org_id and o.order_number ~* '^PED-[0-9]+$';
  v_order_number := 'PED-' || lpad(v_next_order_number::text, 4, '0');

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
    values (p_org_id, v_piece_id, 'braco', v_mold_catalogs->>'braco');
  else
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values
      (p_org_id, v_piece_id, 'leito', v_mold_catalogs->>'leito'),
      (p_org_id, v_piece_id, 'lateral', v_mold_catalogs->>'lateral');
  end if;

  insert into public.orders (
    id, organization_id, order_number, work_id, client_id,
    start_date, requested_due_date, status, observations
  ) values (
    v_order_id, p_org_id, v_order_number, v_work_id, v_client_id,
    v_work_start_date, v_work_due_date, v_order_status, v_order_observations
  );
  insert into public.order_items (
    id, organization_id, order_id, piece_type_id, quantity,
    production_minutes_snapshot, sequence, observations
  ) values (
    v_item_id, p_org_id, v_order_id, v_piece_id, v_quantity,
    v_production_minutes, v_sequence, v_item_observations
  );

  -- O planejador calcula sem gravar; a RPC persiste os dias usados no mesmo commit.
  for v_day in select value from jsonb_array_elements(v_calendar_days)
  loop
    insert into public.calendar_days (
      organization_id, date, is_working, capacity_minutes, source, exception_id, note, generated_at
    ) values (
      p_org_id,
      (v_day->>'date')::date,
      (v_day->>'is_working')::boolean,
      (v_day->>'capacity_minutes')::integer,
      coalesce(nullif(v_day->>'source', ''), 'regra'),
      nullif(v_day->>'exception_id', '')::uuid,
      nullif(trim(v_day->>'note'), ''),
      now()
    )
    on conflict (organization_id, date) do update set
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
      select 1 from jsonb_array_elements(v_plans) as plan(value)
      where plan.value->>'orderId' = v_order_id::text
    ) into v_target_was_planned;
    select result.value into v_target_commit
    from jsonb_array_elements(coalesce(v_queue_result->'orders', '[]'::jsonb)) as result(value)
    where result.value->>'orderId' = v_order_id::text;
  end if;

  select coalesce(array_agg(distinct mp.code order by mp.code), array[]::text[])
  into v_position_codes
  from public.production_orders po
  join public.allocations a
    on a.organization_id = po.organization_id and a.production_order_id = po.id
  join public.mold_positions mp
    on mp.organization_id = a.organization_id and mp.id = a.mold_position_id
  where po.organization_id = p_org_id and po.order_id = v_order_id;

  insert into public.audit_logs (organization_id, entity_name, entity_id, action, actor_label, payload)
  values (
    p_org_id, 'orders', v_order_id, 'registered_with_piece', 'acesso-publico',
    jsonb_build_object(
      'orderNumber', v_order_number, 'workId', v_work_id,
      'itemId', v_item_id, 'pieceId', v_piece_id, 'positionCodes', to_jsonb(v_position_codes)
    )
  );

  return jsonb_build_object(
    'orderId', v_order_id,
    'orderNumber', v_order_number,
    'workId', v_work_id,
    'pieceId', v_piece_id,
    'itemId', v_item_id,
    'positionCodes', to_jsonb(v_position_codes),
    'planning', jsonb_build_object(
      'committed', true,
      'waitingForPosition', not v_target_was_planned,
      'plannedUnitCount', coalesce(nullif(v_target_commit->>'unitCount', '')::integer, 0)
    )
  );
end;
$$;
revoke all on function public.create_order_piece_registration(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_order_piece_registration(uuid, jsonb) to service_role;