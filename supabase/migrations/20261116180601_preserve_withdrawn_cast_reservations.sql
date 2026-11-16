-- A última unidade pode apagar sua alocação por cascata. Preserve também a
-- ocupação do dia de concretagem para que a simulação não use a posição duas
-- vezes, além do estado da forma já registrado no evento.
alter table public.withdrawn_unit_form_events
  add column scheduled_date date,
  add column occupied_from_at timestamptz,
  add column casting_completed boolean;

create function public.fill_withdrawn_unit_form_event()
returns trigger language plpgsql set search_path = '' as $function$
declare
  v_allocation public.allocations;
begin
  select * into v_allocation from public.allocations a
  where a.organization_id = new.organization_id
    and a.id = new.source_allocation_id;
  if not found or v_allocation.production_order_id <> new.source_unit_id then
    raise exception 'A alocação da forma retirada não está disponível.' using errcode = '23503';
  end if;
  new.scheduled_date := v_allocation.scheduled_date;
  new.occupied_from_at := v_allocation.occupied_from_at;
  new.casting_completed := v_allocation.status = 'done' or exists (
    select 1 from public.production_order_steps s
    where s.organization_id = new.organization_id
      and s.production_order_id = new.source_unit_id
      and s.step_kind = 'concretagem' and s.status = 'done'
  );
  return new;
end;
$function$;
revoke all on function public.fill_withdrawn_unit_form_event()
  from public, anon, authenticated;
create trigger trg_fill_withdrawn_unit_form_event
before insert on public.withdrawn_unit_form_events
for each row execute function public.fill_withdrawn_unit_form_event();

alter table public.withdrawn_unit_form_events
  alter column scheduled_date set not null,
  alter column casting_completed set not null;
create index withdrawn_unit_cast_reservation_idx
  on public.withdrawn_unit_form_events (organization_id, scheduled_date)
  where casting_completed;
