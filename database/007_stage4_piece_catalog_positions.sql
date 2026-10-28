-- PRELUX · Etapa 4: catálogo fixo de moldes, dimensões de peças e posições
-- Migração incremental. Mantém os campos antigos para preservar registros e
-- cria campos tipados usados pelos novos cadastros e pelo planejador.

begin;

create table if not exists public.mold_catalog (
  code text primary key,
  mold_type text not null check (mold_type in ('LEITO', 'LATERAL', 'BRACO')),
  measure_label text not null,
  sort_order smallint not null,
  check (
    (mold_type = 'LEITO' and measure_label in ('20','25','30','35','40','50','60')) or
    (mold_type = 'LATERAL' and measure_label in ('25','30','40','50','60')) or
    (mold_type = 'BRACO' and measure_label in ('25x35','25x52','30x60'))
  ),
  unique (mold_type, measure_label)
);

insert into public.mold_catalog (code, mold_type, measure_label, sort_order) values
  ('LEITO_20','LEITO','20',1), ('LEITO_25','LEITO','25',2),
  ('LEITO_30','LEITO','30',3), ('LEITO_35','LEITO','35',4),
  ('LEITO_40','LEITO','40',5), ('LEITO_50','LEITO','50',6),
  ('LEITO_60','LEITO','60',7),
  ('LATERAL_25','LATERAL','25',8), ('LATERAL_30','LATERAL','30',9),
  ('LATERAL_40','LATERAL','40',10), ('LATERAL_50','LATERAL','50',11),
  ('LATERAL_60','LATERAL','60',12),
  ('BRACO_25X35','BRACO','25x35',13), ('BRACO_25X52','BRACO','25x52',14),
  ('BRACO_30X60','BRACO','30x60',15)
on conflict (code) do nothing;

revoke all on public.mold_catalog from public, anon, authenticated;
grant select on public.mold_catalog to service_role;

alter table public.piece_types
  add column if not exists piece_kind text,
  add column if not exists dimension_x_cm numeric(12,3),
  add column if not exists dimension_y_cm numeric(12,3),
  add column if not exists dimension_z_cm numeric(12,3),
  add column if not exists volume_cm3 numeric(36,3);

alter table public.piece_types
  alter column weight_kg type numeric(36,3),
  alter column volume_m3 type numeric(36,6);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'piece_types_piece_kind_check') then
    alter table public.piece_types add constraint piece_types_piece_kind_check
      check (piece_kind is null or piece_kind in ('braco','pilar','viga'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'piece_types_dimensions_positive_check') then
    alter table public.piece_types add constraint piece_types_dimensions_positive_check
      check (
        (dimension_x_cm is null or dimension_x_cm > 0) and
        (dimension_y_cm is null or dimension_y_cm > 0) and
        (dimension_z_cm is null or dimension_z_cm > 0)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'piece_types_dimensions_complete_check') then
    alter table public.piece_types add constraint piece_types_dimensions_complete_check
      check (
        (dimension_x_cm is null and dimension_y_cm is null and dimension_z_cm is null) or
        (dimension_x_cm is not null and dimension_y_cm is not null and dimension_z_cm is not null)
      );
  end if;
end $$;

-- Só classifica códigos que já identificam exatamente um dos três tipos.
update public.piece_types
set piece_kind = case upper(trim(code))
  when 'BRACO' then 'braco'
  when 'BRAÇO' then 'braco'
  when 'PILAR' then 'pilar'
  when 'VIGA' then 'viga'
  else piece_kind
end
where piece_kind is null;

alter table public.molds
  add column if not exists catalog_code text references public.mold_catalog(code);
alter table public.molds alter column cycle_minutes_per_unit drop not null;

create table if not exists public.piece_type_molds (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  piece_type_id uuid not null references public.piece_types(id) on delete cascade,
  role text not null check (role in ('braco','leito','lateral')),
  catalog_code text not null references public.mold_catalog(code) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (piece_type_id, role),
  check (
    (role = 'braco' and catalog_code like 'BRACO_%') or
    (role = 'leito' and catalog_code like 'LEITO_%') or
    (role = 'lateral' and catalog_code like 'LATERAL_%')
  )
);
create index if not exists piece_type_molds_catalog_idx
  on public.piece_type_molds (organization_id, catalog_code, piece_type_id);

alter table public.mold_positions
  add column if not exists configuration_kind text,
  add column if not exists braco_catalog_code text references public.mold_catalog(code) on delete restrict,
  add column if not exists leito_catalog_code text references public.mold_catalog(code) on delete restrict,
  add column if not exists lateral_catalog_code text references public.mold_catalog(code) on delete restrict;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mold_positions_configuration_kind_check') then
    alter table public.mold_positions add constraint mold_positions_configuration_kind_check
      check (configuration_kind is null or configuration_kind in ('braco','pilar_viga'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mold_positions_configuration_shape_check') then
    alter table public.mold_positions add constraint mold_positions_configuration_shape_check
      check (
        (configuration_kind is null and braco_catalog_code is null and leito_catalog_code is null and lateral_catalog_code is null) or
        (configuration_kind = 'braco' and braco_catalog_code is not null and leito_catalog_code is null and lateral_catalog_code is null) or
        (configuration_kind = 'pilar_viga' and braco_catalog_code is null and leito_catalog_code is not null and lateral_catalog_code is not null)
      );
  end if;
end $$;

create table if not exists public.mold_position_configuration_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mold_position_id uuid not null references public.mold_positions(id) on delete cascade,
  position_code text not null check (position_code in ('P01','P02','P03','P04')),
  configuration_kind text,
  braco_catalog_code text references public.mold_catalog(code),
  leito_catalog_code text references public.mold_catalog(code),
  lateral_catalog_code text references public.mold_catalog(code),
  status text not null,
  notes text,
  recorded_at timestamptz not null default now()
);
create index if not exists mold_position_configuration_history_idx
  on public.mold_position_configuration_history (organization_id, mold_position_id, recorded_at desc);

alter table public.piece_type_molds enable row level security;
alter table public.mold_position_configuration_history enable row level security;
revoke all on public.piece_type_molds, public.mold_position_configuration_history from public, anon, authenticated;
grant select on public.piece_type_molds, public.mold_position_configuration_history to service_role;

create or replace function public.save_piece_type(
  p_org_id uuid,
  p_record jsonb,
  p_mold_catalogs jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_code text := upper(nullif(trim(p_record->>'code'), ''));
  v_name text := nullif(trim(p_record->>'name'), '');
  v_kind text := nullif(trim(p_record->>'pieceKind'), '');
  v_x numeric := nullif(p_record->>'dimensionXcm', '')::numeric;
  v_y numeric := nullif(p_record->>'dimensionYcm', '')::numeric;
  v_z numeric := nullif(p_record->>'dimensionZcm', '')::numeric;
  v_arm text := nullif(trim(p_mold_catalogs->>'braco'), '');
  v_bed text := nullif(trim(p_mold_catalogs->>'leito'), '');
  v_side text := nullif(trim(p_mold_catalogs->>'lateral'), '');
  v_row public.piece_types;
begin
  if v_code is null or v_name is null then raise exception 'Informe código e nome da peça.'; end if;
  if v_kind is null or v_kind not in ('braco','pilar','viga') then raise exception 'Selecione Braço, Pilar ou Viga.'; end if;
  if v_x is null or v_y is null or v_z is null or v_x <= 0 or v_y <= 0 or v_z <= 0 then
    raise exception 'Informe dimensões X, Y e Z maiores que zero, em centímetros.';
  end if;
  if coalesce(nullif(p_record->>'productionMinutesPerUnit', '')::integer, 0) <= 0 then
    raise exception 'O tempo de produção registrado precisa ser maior que zero.';
  end if;

  if v_kind = 'braco' then
    if v_arm is null or v_bed is not null or v_side is not null then
      raise exception 'Braço exige um molde BRAÇO e não aceita LEITO/LATERAL.';
    end if;
    if not exists (select 1 from public.mold_catalog where code = v_arm and mold_type = 'BRACO') then
      raise exception 'Selecione uma medida válida do catálogo BRAÇO.';
    end if;
  else
    if v_arm is not null or v_bed is null or v_side is null then
      raise exception 'Pilar e Viga exigem um molde LEITO e um molde LATERAL.';
    end if;
    if not exists (select 1 from public.mold_catalog where code = v_bed and mold_type = 'LEITO')
      or not exists (select 1 from public.mold_catalog where code = v_side and mold_type = 'LATERAL') then
      raise exception 'Selecione medidas válidas de LEITO e LATERAL.';
    end if;
  end if;

  if v_id is not null and exists (
    select 1 from public.resource_allocations a
    join public.order_items oi on oi.id = a.order_item_id
    join public.molds m on m.id = a.mold_id
    where a.organization_id = p_org_id and a.status in ('planned','in_progress')
      and oi.piece_type_id = v_id
      and m.catalog_code is not null
      and not (m.catalog_code = any(array_remove(array[v_arm, v_bed, v_side], null)))
  ) then
    raise exception 'Não é possível trocar os moldes enquanto houver alocação de produção ativa.';
  end if;

  if v_id is not null then
    update public.piece_types set
      code = v_code, name = v_name, piece_kind = v_kind,
      dimension_x_cm = v_x, dimension_y_cm = v_y, dimension_z_cm = v_z,
      dimensions = format('%s × %s × %s cm', v_x, v_y, v_z),
      volume_cm3 = v_x * v_y * v_z,
      volume_m3 = (v_x * v_y * v_z) / 1000000,
      weight_kg = (v_x * v_y * v_z * 2.5) / 1000,
      production_minutes_per_unit = (p_record->>'productionMinutesPerUnit')::integer,
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Tipo de peça não encontrado.'; end if;
  else
    insert into public.piece_types (
      organization_id, code, name, piece_kind, dimension_x_cm, dimension_y_cm, dimension_z_cm,
      dimensions, volume_cm3, weight_kg, volume_m3, production_minutes_per_unit, observations
    ) values (
      p_org_id, v_code, v_name, v_kind, v_x, v_y, v_z,
      format('%s × %s × %s cm', v_x, v_y, v_z), v_x * v_y * v_z,
      (v_x * v_y * v_z * 2.5) / 1000, (v_x * v_y * v_z) / 1000000,
      (p_record->>'productionMinutesPerUnit')::integer,
      nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
    v_id := v_row.id;
  end if;

  delete from public.piece_type_molds where organization_id = p_org_id and piece_type_id = v_id;
  if v_kind = 'braco' then
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values (p_org_id, v_id, 'braco', v_arm);
  else
    insert into public.piece_type_molds (organization_id, piece_type_id, role, catalog_code)
    values (p_org_id, v_id, 'leito', v_bed), (p_org_id, v_id, 'lateral', v_side);
  end if;

  delete from public.mold_piece_types where organization_id = p_org_id and piece_type_id = v_id;
  insert into public.mold_piece_types (organization_id, mold_id, piece_type_id)
  select p_org_id, m.id, v_id
  from public.molds m
  join public.piece_type_molds requirements
    on requirements.organization_id = p_org_id and requirements.piece_type_id = v_id
    and requirements.catalog_code = m.catalog_code
  where m.organization_id = p_org_id and m.status <> 'retirado'
  on conflict (mold_id, piece_type_id) do nothing;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.save_mold(
  p_org_id uuid,
  p_record jsonb,
  p_piece_type_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_catalog_code text := nullif(trim(p_record->>'catalogCode'), '');
  v_status text := coalesce(nullif(p_record->>'status', ''), 'ativo');
  v_cycle integer := nullif(p_record->>'cycleMinutesPerUnit', '')::integer;
  v_catalog public.mold_catalog;
  v_row public.molds;
  v_code text;
  v_next integer;
begin
  if v_catalog_code is null then raise exception 'Selecione uma opção fixa do catálogo de moldes.'; end if;
  select * into v_catalog from public.mold_catalog where code = v_catalog_code;
  if not found then raise exception 'Molde não encontrado no catálogo fixo.'; end if;
  if v_cycle is not null and v_cycle <= 0 then raise exception 'O ciclo do molde precisa ser maior que zero.'; end if;
  if v_status not in ('ativo','manutencao','bloqueado','retirado') then raise exception 'Status do molde inválido.'; end if;

  if v_id is not null then
    if v_status <> 'ativo' and exists (
      select 1 from public.resource_allocations where organization_id = p_org_id and mold_id = v_id and status in ('planned','in_progress')
    ) then raise exception 'Cancele as alocações planejadas ou em andamento antes de bloquear o molde.'; end if;
    if v_status = 'retirado' and exists (
      select 1 from public.mold_preparations where organization_id = p_org_id and mold_id = v_id
        and status in ('planejada','em_andamento','aguardando_aprovacao')
    ) then raise exception 'Conclua ou cancele as preparações pendentes antes de retirar o molde.'; end if;
    if exists (
      select 1 from public.resource_allocations where organization_id = p_org_id and mold_id = v_id and status in ('planned','in_progress')
    ) and exists (select 1 from public.molds where id = v_id and catalog_code is distinct from v_catalog_code) then
      raise exception 'Não é possível trocar a medida de um molde com produção ativa.';
    end if;
    update public.molds set
      catalog_code = v_catalog_code,
      mold_type = v_catalog.mold_type,
      dimensions = v_catalog.measure_label || ' cm',
      name = v_catalog.mold_type || ' ' || v_catalog.measure_label || ' cm',
      cycle_minutes_per_unit = v_cycle,
      status = v_status,
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Molde não encontrado.'; end if;
  else
    perform pg_advisory_xact_lock(hashtext(p_org_id::text || ':mold-catalog:' || v_catalog_code)::bigint);
    select count(*)::integer + 1 into v_next from public.molds
    where organization_id = p_org_id and catalog_code = v_catalog_code;
    v_code := v_catalog_code || '-' || lpad(v_next::text, greatest(3, length(v_next::text)), '0');
    insert into public.molds (
      organization_id, code, name, mold_type, dimensions, catalog_code,
      cycle_minutes_per_unit, status, observations
    ) values (
      p_org_id, v_code, v_catalog.mold_type || ' ' || v_catalog.measure_label || ' cm',
      v_catalog.mold_type, v_catalog.measure_label || ' cm', v_catalog_code,
      v_cycle, v_status, nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
    v_id := v_row.id;
  end if;

  delete from public.mold_piece_types where organization_id = p_org_id and mold_id = v_id;
  insert into public.mold_piece_types (organization_id, mold_id, piece_type_id)
  select p_org_id, m.id, requirements.piece_type_id
  from public.piece_type_molds requirements
  where requirements.organization_id = p_org_id and requirements.catalog_code = v_catalog_code
  on conflict (mold_id, piece_type_id) do nothing;
  return to_jsonb(v_row);
end;
$$;

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
set search_path = public
as $$
declare
  v_row public.mold_positions;
  v_braco text := nullif(trim(p_braco_catalog_code), '');
  v_leito text := nullif(trim(p_leito_catalog_code), '');
  v_lateral text := nullif(trim(p_lateral_catalog_code), '');
begin
  if p_code is null or p_code not in ('P01','P02','P03','P04') then raise exception 'Posição de molde inválida.'; end if;
  if p_status is null or p_status not in ('disponivel','em_preparacao','em_producao','em_manutencao') then raise exception 'Status da posição inválido.'; end if;
  if p_configuration_kind = 'braco' then
    if v_braco is null or v_leito is not null or v_lateral is not null
      or not exists (select 1 from public.mold_catalog where code = v_braco and mold_type = 'BRACO') then
      raise exception 'Configure a posição com uma única medida BRAÇO do catálogo.';
    end if;
  elsif p_configuration_kind = 'pilar_viga' then
    if v_braco is not null or v_leito is null or v_lateral is null
      or not exists (select 1 from public.mold_catalog where code = v_leito and mold_type = 'LEITO')
      or not exists (select 1 from public.mold_catalog where code = v_lateral and mold_type = 'LATERAL') then
      raise exception 'Configure a posição com um molde LEITO e um molde LATERAL.';
    end if;
  else
    raise exception 'Selecione Braço ou Pilar/Viga para a configuração da posição.';
  end if;

  select * into v_row from public.mold_positions
  where organization_id = p_org_id and code = p_code for update;
  if not found then raise exception 'A posição ainda não foi criada nesta unidade. Aplique a migração 006.'; end if;

  if v_row.configuration_kind is distinct from p_configuration_kind
    or v_row.braco_catalog_code is distinct from v_braco
    or v_row.leito_catalog_code is distinct from v_leito
    or v_row.lateral_catalog_code is distinct from v_lateral then
    if exists (
      select 1
      from public.allocations a
      join public.production_orders po on po.id = a.production_order_id
      where a.organization_id = p_org_id
        and a.mold_position_id = v_row.id
        and a.status = 'in_progress'
        and po.status = 'in_progress'
    ) then
      raise exception 'Não é possível trocar os moldes enquanto há concretagem em andamento nesta posição.';
    end if;
  end if;
  if v_row.status is distinct from p_status
    and exists (
      select 1
      from public.allocations a
      join public.production_orders po on po.id = a.production_order_id
      where a.organization_id = p_org_id
        and a.mold_position_id = v_row.id
        and a.status = 'in_progress'
        and po.status = 'in_progress'
    )
    and p_status <> 'em_producao' then
    raise exception 'A posição deve permanecer em produção enquanto houver uma concretagem em andamento.';
  end if;

  if v_row.status is distinct from p_status
    or v_row.configuration_kind is distinct from p_configuration_kind
    or v_row.braco_catalog_code is distinct from v_braco
    or v_row.leito_catalog_code is distinct from v_leito
    or v_row.lateral_catalog_code is distinct from v_lateral
    or v_row.notes is distinct from nullif(trim(p_notes), '') then
    insert into public.mold_position_configuration_history (
      organization_id, mold_position_id, position_code, configuration_kind,
      braco_catalog_code, leito_catalog_code, lateral_catalog_code, status, notes
    ) values (
      p_org_id, v_row.id, v_row.code, v_row.configuration_kind,
      v_row.braco_catalog_code, v_row.leito_catalog_code, v_row.lateral_catalog_code, v_row.status, v_row.notes
    );
    update public.mold_positions set
      status = p_status,
      configuration_kind = p_configuration_kind,
      braco_catalog_code = v_braco,
      leito_catalog_code = v_leito,
      lateral_catalog_code = v_lateral,
      notes = nullif(trim(p_notes), '')
    where id = v_row.id and organization_id = p_org_id
    returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.save_piece_type(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_mold_position(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_piece_type(uuid, jsonb, jsonb) to service_role;
grant execute on function public.save_mold_position(uuid, text, text, text, text, text, text, text) to service_role;

commit;
