-- Etapa 4: recibo idempotente da confirmação explícita do Planejamento.
-- Depende da Etapa 5 já instalada (commit_factory_simulation e revisão da fila).
-- Não persiste prévias; grava apenas o resultado da confirmação transacional.

begin;

create table if not exists public.factory_plan_confirmation_receipts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key uuid not null,
  request_fingerprint text not null check (char_length(request_fingerprint) between 1 and 2048),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (organization_id, idempotency_key)
);

alter table public.factory_plan_confirmation_receipts enable row level security;
revoke all on public.factory_plan_confirmation_receipts from public, anon, authenticated;
grant select on public.factory_plan_confirmation_receipts to service_role;

create or replace function public.commit_factory_simulation_idempotent(
  p_org_id uuid,
  p_expected_revision bigint,
  p_approve_order_ids uuid[],
  p_plans jsonb,
  p_calendar_days jsonb,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_scenario jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_saved_fingerprint text;
  v_saved_response jsonb;
  v_commit_result jsonb;
  v_response jsonb;
begin
  if p_org_id is null or p_idempotency_key is null
    or p_request_fingerprint is null
    or pg_catalog.char_length(p_request_fingerprint) not between 1 and 2048
    or p_scenario is null or pg_catalog.jsonb_typeof(p_scenario) <> 'object' then
    raise exception 'A confirmação precisa de chave, identificação da solicitação e cenário válidos.'
      using errcode = '22023';
  end if;

  -- Serializa apenas repetições da mesma solicitação. A RPC original continua
  -- protegendo a fila da organização e comparando a revisão do cenário.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'prelux-factory-confirm:' || p_org_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select receipt.request_fingerprint, receipt.response
    into v_saved_fingerprint, v_saved_response
  from public.factory_plan_confirmation_receipts receipt
  where receipt.organization_id = p_org_id
    and receipt.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_saved_fingerprint is distinct from p_request_fingerprint then
      raise exception 'Esta chave de confirmação já foi usada com outra solicitação.'
        using errcode = '23505';
    end if;
    return v_saved_response || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- A gravação do plano e o recibo idempotente pertencem à mesma transação.
  v_commit_result := public.commit_factory_simulation(
    p_org_id,
    p_expected_revision,
    p_approve_order_ids,
    p_plans,
    p_calendar_days
  );
  v_response := pg_catalog.jsonb_build_object(
    'scenario', p_scenario,
    'result', v_commit_result,
    'replayed', false
  );

  insert into public.factory_plan_confirmation_receipts (
    organization_id,
    idempotency_key,
    request_fingerprint,
    response
  ) values (
    p_org_id,
    p_idempotency_key,
    p_request_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

revoke all on function public.commit_factory_simulation_idempotent(
  uuid, bigint, uuid[], jsonb, jsonb, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_factory_simulation_idempotent(
  uuid, bigint, uuid[], jsonb, jsonb, uuid, text, jsonb
) to service_role;

commit;
