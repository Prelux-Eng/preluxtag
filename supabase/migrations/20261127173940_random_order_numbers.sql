-- Gera códigos legíveis e aleatórios para novos pedidos.
-- Os números históricos continuam preservados.

create or replace function public.generate_order_number(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_random numeric;
  v_code text;
  v_index integer;
begin
  if p_org_id is null then
    raise exception 'A unidade do pedido é obrigatória para gerar o número.';
  end if;

  -- Serializa a geração por unidade para reduzir colisões em cadastros simultâneos.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_org_id::text),
    pg_catalog.hashtext('generate_order_number')
  );

  loop
    v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
    v_random := 0;
    for v_index in 0..4 loop
      v_random := v_random * 256 + pg_catalog.get_byte(v_bytes, v_index);
    end loop;

    v_code := '';
    for v_index in 1..8 loop
      v_code := pg_catalog.substr(v_alphabet, mod(v_random, 32)::integer + 1, 1) || v_code;
      v_random := trunc(v_random / 32);
    end loop;

    v_code := 'PED-' || pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4);

    exit when not exists (
      select 1
      from public.orders o
      where o.organization_id = p_org_id
        and upper(o.order_number) = v_code
    );
  end loop;

  return v_code;
end;
$$;

revoke all on function public.generate_order_number(uuid) from public, anon, authenticated;
grant execute on function public.generate_order_number(uuid) to service_role;

-- O código só nasce automaticamente. Alterações posteriores não o substituem.
create or replace function public.keep_order_number_generated()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.order_number is null
      or new.order_number !~* '^PED-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$' then
      new.order_number := public.generate_order_number(new.organization_id);
    end if;
  elsif new.order_number is distinct from old.order_number then
    new.order_number := old.order_number;
  end if;

  return new;
end;
$$;

revoke all on function public.keep_order_number_generated() from public, anon, authenticated;

drop trigger if exists orders_keep_generated_number on public.orders;
create trigger orders_keep_generated_number
before insert or update of order_number on public.orders
for each row execute function public.keep_order_number_generated();

-- A chave é única dentro da unidade, sem conflitar com pedidos históricos PED-0001.
create unique index if not exists orders_org_random_number_uidx
  on public.orders (organization_id, upper(order_number))
  where order_number ~* '^PED-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$';

-- Mantém o número retornado pela RPC igual ao que foi persistido.
do $patch_header$
declare
  v_definition text;
  v_old text := $old_header$
  select coalesce(max(substring(o.order_number from 5)::numeric), 0) + 1
  into v_next_number
  from public.orders o
  where o.organization_id = p_org_id and o.order_number ~* '^PED-[0-9]+$';
  v_order_number := 'PED-' || lpad(v_next_number::text, 4, '0');
$old_header$;
begin
  select pg_catalog.pg_get_functiondef('public.create_order_header(uuid,jsonb)'::regprocedure)
  into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'Não foi possível localizar a geração sequencial em create_order_header.';
  end if;
  execute replace(v_definition, v_old, '  v_order_number := public.generate_order_number(p_org_id);');
end;
$patch_header$;

-- Atualiza também a RPC antiga que ainda pode receber cadastros integrados.
do $patch_registration$
declare
  v_definition text;
  v_old text := $old_registration$
  select coalesce(max(substring(o.order_number from 5)::numeric), 0) + 1
  into v_next_order_number
  from public.orders o
  where o.organization_id = p_org_id and o.order_number ~* '^PED-[0-9]+$';
  v_order_number := 'PED-' || lpad(v_next_order_number::text, 4, '0');
$old_registration$;
begin
  select pg_catalog.pg_get_functiondef('public.create_order_piece_registration(uuid,jsonb)'::regprocedure)
  into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'Não foi possível localizar a geração sequencial em create_order_piece_registration.';
  end if;
  execute replace(v_definition, v_old, '  v_order_number := public.generate_order_number(p_org_id);');
end;
$patch_registration$;

-- O cadastro legado também passa a pedir um código ao banco em vez de confiar no formulário.
do $patch_save$
declare
  v_definition text;
  v_old text := $old_insert$p_org_id, nullif(trim(p_order->>'orderNumber'), ''), v_work_id, v_client_id,$old_insert$;
begin
  select pg_catalog.pg_get_functiondef('public.save_order_with_items(uuid,jsonb,jsonb)'::regprocedure)
  into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'Não foi possível localizar a inclusão de pedido em save_order_with_items.';
  end if;
  execute replace(
    v_definition,
    v_old,
    'p_org_id, public.generate_order_number(p_org_id), v_work_id, v_client_id,'
  );
end;
$patch_save$;
