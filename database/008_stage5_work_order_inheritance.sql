-- PRELUX · Etapa 5: herança de cliente e data de início da obra no pedido
-- Incremental: reaproveita works/orders e sincroniza pedidos ainda não iniciados.

begin;

create or replace function public.inherit_order_work_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_work_client_id uuid;
  v_work_start_date date;
begin
  if new.work_id is not null then
    select client_id, start_date
      into v_work_client_id, v_work_start_date
    from public.works
    where id = new.work_id and organization_id = new.organization_id;

    if not found then
      raise exception 'Obra não encontrada nesta unidade.';
    end if;
    if v_work_start_date is null then
      raise exception 'Cadastre a data de início da obra antes de vincular o pedido.';
    end if;

    new.client_id := v_work_client_id;
    new.start_date := v_work_start_date;
  end if;

  if new.requested_due_date is not null and new.requested_due_date < new.start_date then
    raise exception 'O prazo solicitado não pode ser anterior à data de início do pedido.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_inherit_work_fields on public.orders;
create trigger trg_orders_inherit_work_fields
  before insert or update on public.orders
  for each row execute function public.inherit_order_work_fields();

create or replace function public.sync_work_fields_to_orders()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.client_id is not distinct from old.client_id
    and new.start_date is not distinct from old.start_date then
    return new;
  end if;

  if exists (
    select 1
    from public.orders o
    left join public.production_orders po
      on po.organization_id = o.organization_id and po.order_id = o.id
    left join public.production_schedules ps
      on ps.organization_id = o.organization_id and ps.order_id = o.id
    where o.organization_id = new.organization_id and o.work_id = new.id
      and (
        o.status in ('em_producao','concluido','entregue')
        or po.status in ('in_progress','done','scrapped')
        or ps.status in ('in_progress','done')
      )
  ) then
    raise exception 'Não é possível alterar cliente ou início da obra depois que um pedido vinculado começou a produção.';
  end if;

  if exists (
    select 1 from public.orders o
    where o.organization_id = new.organization_id and o.work_id = new.id
      and (new.start_date is null or (o.requested_due_date is not null and o.requested_due_date < new.start_date))
  ) then
    raise exception 'A data da obra precisa ser informada e não pode ultrapassar o prazo solicitado de um pedido vinculado.';
  end if;

  update public.orders o
  set client_id = new.client_id,
      start_date = new.start_date
  where o.organization_id = new.organization_id and o.work_id = new.id
    and (o.client_id is distinct from new.client_id or o.start_date is distinct from new.start_date);

  return new;
end;
$$;

drop trigger if exists trg_works_sync_order_fields on public.works;
create trigger trg_works_sync_order_fields
  after update of client_id, start_date on public.works
  for each row execute function public.sync_work_fields_to_orders();

create or replace view public.piece_mold_combinations as
select
  'braco'::text as piece_kind,
  'braco'::text as configuration_kind,
  arm.code as option_key,
  arm.code as braco_catalog_code,
  null::text as leito_catalog_code,
  null::text as lateral_catalog_code,
  ('BRAÇO ' || arm.measure_label || ' cm') as label,
  arm.sort_order::integer as sort_order
from public.mold_catalog arm
where arm.mold_type = 'BRACO'
union all
select
  kinds.piece_kind,
  'pilar_viga'::text as configuration_kind,
  (bed.code || '|' || side.code) as option_key,
  null::text as braco_catalog_code,
  bed.code as leito_catalog_code,
  side.code as lateral_catalog_code,
  ('LEITO ' || bed.measure_label || ' cm × LATERAL ' || side.measure_label || ' cm') as label,
  (bed.sort_order * 100 + side.sort_order)::integer as sort_order
from (values ('pilar'::text), ('viga'::text)) as kinds(piece_kind)
cross join public.mold_catalog bed
cross join public.mold_catalog side
where bed.mold_type = 'LEITO' and side.mold_type = 'LATERAL';

revoke all on public.piece_mold_combinations from public, anon, authenticated;
grant select on public.piece_mold_combinations to service_role;

revoke all on function public.inherit_order_work_fields() from public, anon, authenticated;
revoke all on function public.sync_work_fields_to_orders() from public, anon, authenticated;
grant execute on function public.inherit_order_work_fields() to service_role;
grant execute on function public.sync_work_fields_to_orders() to service_role;

commit;
