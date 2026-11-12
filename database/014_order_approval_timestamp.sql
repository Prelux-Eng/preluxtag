-- Etapa 2: guarda a hora da aprovação que define a prioridade da fila.
-- Não altera as datas nem o status dos pedidos existentes.
begin;

alter table public.orders
  add column if not exists approved_at timestamptz;

create or replace function public.capture_order_approval_time()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.approved_at := case
      when new.status in ('aprovado', 'em_producao', 'atrasado') then now()
      else null
    end;
  elsif new.status = 'aprovado'
    and old.status not in ('aprovado', 'em_producao', 'atrasado') then
    -- Nova aprovação (inclusive após voltar a orçamento) ganha nova prioridade.
    new.approved_at := now();
  elsif new.status = 'orcamento' and old.status <> 'orcamento' then
    new.approved_at := null;
  elsif old.approved_at is null
    and new.status in ('aprovado', 'em_producao', 'atrasado') then
    -- Cobre pedidos históricos aprovados antes desta migration.
    new.approved_at := coalesce(old.updated_at, old.created_at, now());
  else
    -- Uma edição comum não pode reordenar a aprovação.
    new.approved_at := old.approved_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_capture_order_approval_time on public.orders;
create trigger trg_capture_order_approval_time
before insert or update on public.orders
for each row execute function public.capture_order_approval_time();

create index if not exists orders_approval_queue_idx
  on public.orders (organization_id, approved_at, created_at, id)
  where is_active = true
    and status in ('aprovado', 'em_producao', 'atrasado');

comment on column public.orders.approved_at is
  'Instante da aprovação vigente; ordena pedidos firmes na simulação da produção.';

revoke all on function public.capture_order_approval_time() from public, anon, authenticated;

commit;
