# Backend PRELUX · planejamento e cadastros operacionais

O backend usa Supabase/PostgreSQL e Edge Functions em Deno. O PWA consome o calendário e os cadastros de obras, pedidos, peças e moldes.

## Publicação

1. Crie um projeto no Supabase.
2. Execute `database/001_initial_schema.sql` até `database/006_position_based_planning.sql`, nessa ordem. Em uma instalação que já tem 001–005, aplique apenas a migração 006 antes de publicar as funções alteradas.
3. Instale a CLI do Supabase e faça login.
4. Configure somente o identificador da organização no projeto:

```bash
supabase secrets set PRELUX_ORGANIZATION_ID=11111111-1111-4111-8111-111111111111
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são fornecidas automaticamente às Edge Functions hospedadas. Não tente cadastrá-las como segredos personalizados. A `service_role` nunca deve ser publicada no HTML, PWA, GitHub ou aplicativo mobile.

5. Publique as funções. O sistema não exige login do operador nesta fase, mas a validação JWT padrão continua ativa; o Site envia a chave pública `anon` no cabeçalho e nunca recebe a `service_role`:

```bash
supabase functions deploy health
supabase functions deploy rebuild-calendar
supabase functions deploy calendar-admin
supabase functions deploy plan-order
supabase functions deploy commit-order-plan
supabase functions deploy operations-admin
```

Não use `--no-verify-jwt` em produção sem uma decisão explícita: essa opção deixa a função acessível sem um JWT válido.

6. Gere o calendário inicial chamando `rebuild-calendar` uma vez. Depois, a tela de configurações poderá chamar a mesma função quando houver mudanças de feriados ou capacidade.

## Endpoints

Todos recebem `POST` com JSON e aceitam `OPTIONS` para CORS.

| Endpoint | Entrada principal | Resultado |
|---|---|---|
| `health` | `{}` | Verifica disponibilidade da API |
| `rebuild-calendar` | `{ startDate, endDate }` | Gera/atualiza `calendar_days` |
| `plan-order` | `{ orderId, startDate?, requestedDueDate? }` | Prévia da programação por posição, prazo base e conflitos |
| `commit-order-plan` | mesmos campos + `allowInfeasible?` | Recalcula e grava a programação por posição |
| `calendar-admin` com `action: planning_data` | `{ startDate, endDate }` | Lista pedidos ativos e programações do período para o calendário |
| `calendar-admin` com `action: get_settings` | `{}` | Lê capacidade padrão e dias de trabalho |
| `calendar-admin` com `action: save_settings` | `{ defaultCapacityMinutes, rules }` | Salva dias úteis e capacidade diária padrão |
| `operations-admin` com `action: bootstrap` | `{}` | Lê obras, pedidos, catálogo, moldes, preparações e alocações |
| `operations-admin` com `action: save_work` | campos da obra e cliente | Cria ou atualiza uma obra |
| `operations-admin` com `action: save_order` | pedido + lista de itens | Grava pedido e itens em uma transação |
| `operations-admin` com `action: calculate_piece_metrics` | `{ x, y, z }` em cm | Calcula volume em cm³/m³ e peso estimado em kg |
| `operations-admin` com `action: save_delay_adjustment` | pedido, motivo, data e nova previsão | Registra reajuste manual e atualiza a previsão |
| `operations-admin` com `action: save_piece_type` | catálogo + moldes compatíveis | Cria ou atualiza um tipo de peça |
| `operations-admin` com `action: save_mold` | molde + peças compatíveis | Cria ou atualiza um molde |
| `operations-admin` com `action: save_preparation` | molde, início, checklist e status | Registra preparação contínua de sete dias |
| `operations-admin` com `action: save_allocation` | recurso, pedido/peça e período | Reserva molde ou registra exceção justificada de outro recurso |

Ao salvar ou replanejar um pedido, `operations-admin` chama o motor e regrava em uma transação a fila dos pedidos ainda não iniciados, por data de início e ordem de cadastro. Se um prazo solicitado for inviável, a programação calcula a data base mais próxima e retorna o aviso junto com o pedido salvo. As Edge Functions alteradas dependem da migração 006, que instala o RPC `commit_planning_queue`.

O prazo base usa quatro posições, uma concretagem por posição em cada dia útil, dois dias corridos de cura e acabamento no primeiro dia útil seguinte. O tempo de produção fica como registro e não limita capacidade. A falta de material não altera esta programação base; a validação de liberação por materiais pertence às etapas de BOM e produção.

Depois de aplicar as migrações, publique também `operations-admin`, `calendar-admin`, `plan-order` e `commit-order-plan`. Não há seed de moldes: códigos, dimensões e ciclos precisam vir do cadastro real da unidade. O setup de troca de configuração da posição continua pendente de definição.

## Teste local do cálculo

O planejador é puro e não depende de Supabase:

```bash
npm test
```

As funções que acessam banco precisam de um projeto Supabase para execução real. O acesso totalmente aberto é uma decisão de negócio da fase inicial: qualquer pessoa com a URL pode chamar as funções. RLS, validações, auditoria e soft delete reduzem o risco, mas não substituem login, rate limit, backups e revisão de permissões antes de uso em produção.
