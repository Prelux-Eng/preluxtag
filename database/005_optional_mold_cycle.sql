begin;

alter table public.molds
  alter column cycle_minutes_per_unit drop not null;

create or replace function public.save_mold(p_org_id uuid, p_record jsonb, p_piece_type_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_record->>'id', '')::uuid;
  v_code text := upper(nullif(trim(p_record->>'code'), ''));
  v_name text := nullif(trim(p_record->>'name'), '');
  v_status text := coalesce(nullif(p_record->>'status', ''), 'ativo');
  v_cycle integer := nullif(p_record->>'cycleMinutesPerUnit', '')::integer;
  v_row public.molds;
  v_expected integer := coalesce(cardinality(p_piece_type_ids), 0);
  v_valid integer;
begin
  if v_code is null or v_name is null then raise exception 'Informe código e nome do molde.'; end if;
  if v_cycle is not null and v_cycle <= 0 then
    raise exception 'O ciclo do molde precisa ser maior que zero.';
  end if;
  select count(distinct selected.piece_type_id)::integer into v_valid
    from unnest(coalesce(p_piece_type_ids, '{}'::uuid[])) as selected(piece_type_id)
    join public.piece_types p on p.id = selected.piece_type_id and p.organization_id = p_org_id;
  if v_valid <> v_expected then raise exception 'Uma ou mais peças compatíveis são inválidas.'; end if;

  if v_id is not null then
    if v_status <> 'ativo' and exists (
      select 1 from public.resource_allocations
      where organization_id = p_org_id and mold_id = v_id and status in ('planned', 'in_progress')
    ) then
      raise exception 'Cancele as alocações planejadas ou em andamento antes de bloquear o molde.';
    end if;
    if v_status = 'retirado' and exists (
      select 1 from public.mold_preparations
      where organization_id = p_org_id and mold_id = v_id
        and status in ('planejada', 'em_andamento', 'aguardando_aprovacao')
    ) then
      raise exception 'Conclua ou cancele as preparações pendentes antes de retirar o molde.';
    end if;
    if exists (
      select 1 from public.resource_allocations a
      join public.order_items oi on oi.id = a.order_item_id
      where a.organization_id = p_org_id and a.resource_kind = 'mold' and a.mold_id = v_id
        and a.status in ('planned', 'in_progress')
        and not (oi.piece_type_id = any(coalesce(p_piece_type_ids, '{}'::uuid[])))
    ) then
      raise exception 'A compatibilidade não pode remover uma peça usada por uma produção planejada.';
    end if;
    update public.molds set
      code = v_code, name = v_name, mold_type = coalesce(nullif(trim(p_record->>'moldType'), ''), 'personalizado'),
      dimensions = coalesce(p_record->>'dimensions', ''),
      cycle_minutes_per_unit = v_cycle,
      status = v_status,
      observations = nullif(trim(p_record->>'observations'), '')
    where id = v_id and organization_id = p_org_id
    returning * into v_row;
    if not found then raise exception 'Molde não encontrado.'; end if;
  else
    insert into public.molds (
      organization_id, code, name, mold_type, dimensions, cycle_minutes_per_unit, status, observations
    ) values (
      p_org_id, v_code, v_name, coalesce(nullif(trim(p_record->>'moldType'), ''), 'personalizado'),
      coalesce(p_record->>'dimensions', ''), v_cycle,
      v_status, nullif(trim(p_record->>'observations'), '')
    ) returning * into v_row;
    v_id := v_row.id;
  end if;

  delete from public.mold_piece_types where organization_id = p_org_id and mold_id = v_id;
  insert into public.mold_piece_types (organization_id, mold_id, piece_type_id)
    select p_org_id, v_id, selected.piece_type_id
    from unnest(coalesce(p_piece_type_ids, '{}'::uuid[])) as selected(piece_type_id);
  return to_jsonb(v_row);
end;
$$;

commit;
