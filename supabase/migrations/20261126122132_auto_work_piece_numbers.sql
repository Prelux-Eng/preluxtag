-- Obras recebem seis dígitos; peças do catálogo recebem sete.
-- Códigos antigos permanecem iguais para não romper pedidos e etiquetas.
begin;

create sequence if not exists public.prelux_work_number_seq
  as bigint start with 1 increment by 1 minvalue 1 maxvalue 999999 no cycle;
create sequence if not exists public.prelux_piece_number_seq
  as bigint start with 1 increment by 1 minvalue 1 maxvalue 9999999 no cycle;

-- A sequência começa depois do maior código que já siga o formato novo.
-- Em uma reaplicação, nunca retrocede em relação ao último número reservado.
do $$
declare
  v_existing bigint;
  v_last bigint;
  v_called boolean;
  v_target bigint;
begin
  select coalesce(max(work_number::bigint), 0) into v_existing
  from public.works where work_number ~ '^[0-9]{6}$';
  select last_value, is_called into v_last, v_called from public.prelux_work_number_seq;
  v_target := greatest(v_existing, case when v_called then v_last else 0 end);
  perform setval('public.prelux_work_number_seq'::regclass, greatest(v_target, 1), v_target > 0);

  select coalesce(max(code::bigint), 0) into v_existing
  from public.piece_types where code ~ '^[0-9]{7}$';
  select last_value, is_called into v_last, v_called from public.prelux_piece_number_seq;
  v_target := greatest(v_existing, case when v_called then v_last else 0 end);
  perform setval('public.prelux_piece_number_seq'::regclass, greatest(v_target, 1), v_target > 0);
end;
$$;

create or replace function public.next_registration_code(p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'work' then
    return lpad(nextval('public.prelux_work_number_seq'::regclass)::text, 6, '0');
  elsif p_kind = 'piece' then
    return lpad(nextval('public.prelux_piece_number_seq'::regclass)::text, 7, '0');
  end if;
  raise exception 'Tipo de numeração inválido.';
end;
$$;

revoke all on sequence public.prelux_work_number_seq, public.prelux_piece_number_seq
  from public, anon, authenticated;
revoke all on function public.next_registration_code(text)
  from public, anon, authenticated;
grant execute on function public.next_registration_code(text) to service_role;

commit;
