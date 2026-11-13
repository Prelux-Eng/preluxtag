# Backend PRELUX · Supabase

O PWA é um site estático. As Edge Functions recebem os pedidos e consultam o
Supabase/PostgreSQL com a credencial de servidor; o navegador usa apenas a
chave pública. Esta primeira fase funciona sem login.

## Fluxo atual

1. **PEDIDOS** recebe obra, pedido e itens. Um orçamento pode ser salvo sem
   reservar capacidade.
2. **ENGENHARIA / PROJETO** organiza os itens e suas formas. Braço usa um
   molde BRAÇO; pilar e viga usam LEITO + LATERAL; placa usa uma bancada plana.
3. **PLANEJAMENTO** simula a fila aprovada e orçamentos selecionados, usando
   P01–P04, calendário e a forma que ficou montada na posição.
4. **CONFIRMAÇÃO** recalcula o cenário no servidor, aprova os orçamentos
   marcados e grava as reservas em uma transação. Se o banco mudou desde a
   prévia, a revisão da fila faz a confirmação falhar para uma nova simulação.
5. **ETIQUETAS** permanece no PWA.

A preparação ocupa a posição por cinco dias úteis quando a forma muda.
Concretagem ocupa um dia útil; cura dura dois dias corridos fora da posição;
acabamento usa o primeiro dia útil após a cura. O horário inicial vem da
constante `casting_start_hour`, e a duração do turno vem do calendário.
Uma forma concluída continua pronta até ser trocada ou desmontada.

## Schema e publicação

Em uma instalação nova, aplique `database/001_initial_schema.sql` até
`database/014_order_approval_timestamp.sql` em ordem, depois as migrations de
`supabase/migrations/` na ordem indicada em
[database/README.md](../database/README.md). O projeto ativo já recebeu essas
alterações; não reaplique os scripts nele. As migrations da Etapa 5 são:

- `20261112184304_stage5_transactional_factory_plan.sql`
- `20261113115042_stage5_form_state_and_closed_orders.sql`
- `20261113123225_stage5_ignore_cancelled_form_history.sql`
- `20261113165527_order_completed_piece_ready.sql`
- `20261113170020_ready_unit_protection.sql`
- `20261113171705_order_production_labels.sql`

As Edge Functions hospedadas recebem `SUPABASE_URL` e
`SUPABASE_SERVICE_ROLE_KEY` no servidor. Configure
`PRELUX_ORGANIZATION_ID` no projeto Supabase. Nunca publique a
`service_role` no HTML, no GitHub ou em um aplicativo distribuído.
Mantenha a validação JWT das funções ativa; o Site envia a chave pública no
cabeçalho.

Funções da interface atual: `operations-admin`, `calendar-admin`,
`simulate-production` e `confirm-production-plan`. As rotas
`plan-order` e `commit-order-plan` são legadas; a segunda responde HTTP 410
e não grava programação. Atualize schema e funções antes de publicar o HTML
que usa o novo contrato.

## Endpoints principais

Todos recebem `POST` com JSON e aceitam `OPTIONS` para CORS.

| Endpoint | Entrada | Resultado |
| --- | --- | --- |
| `simulate-production` | `{ orderIds: ["uuid"] }` | Prévia sem gravação; inclui a fila aprovada e os orçamentos selecionados |
| `confirm-production-plan` | `{ confirmScenario: true, orderIds: ["uuid"] }` | Recalcula e confirma a fila em uma transação; exige seleção explícita dos orçamentos |
| `operations-admin`, `bootstrap` | `{ action: "bootstrap" }` | Lê obras, pedidos, peças, formas, posições e etiquetas geradas |
| `operations-admin`, `reset_position_form` | `{ action: "reset_position_form", code: "P01" }` | Desmonta a forma quando não há unidade reservada |
| `operations-admin`, `complete_production_step` | `{ action: "complete_production_step", stepId: "uuid" }` | Conclui a etapa; marca a unidade Pronta e o pedido Concluído quando todas as unidades terminam |
| `calendar-admin`, `planning_data` | Período | Lê a programação e os ajustes do calendário |
| `rebuild-calendar` | Período | Regenera os dias do calendário quando necessário |

As ações de cadastro de `operations-admin` estão implementadas em
[`supabase/functions/operations-admin/index.ts`](../supabase/functions/operations-admin/index.ts).
O contrato da fila está em
[`docs/ETAPA5_CONFIRMACAO_PLANO.md`](../docs/ETAPA5_CONFIRMACAO_PLANO.md).

## Verificação

O motor diário pode ser conferido com
`node --test tests/factory-simulator.test.mjs`. A simulação e o carregamento
de cadastros podem ser chamados sem alterar pedidos; uma confirmação real
aprova orçamentos e substitui reservas planejadas.
