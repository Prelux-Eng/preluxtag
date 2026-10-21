# Backend PRELUX · Etapa 2

O backend usa Supabase/PostgreSQL e Edge Functions em Deno. A interface atual continua estática; esta camada será consumida por ela nas próximas etapas.

## Publicação

1. Crie um projeto no Supabase.
2. Execute `database/001_initial_schema.sql` e depois `database/002_stage2_functions.sql`.
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
supabase functions deploy plan-order
supabase functions deploy commit-order-plan
```

Não use `--no-verify-jwt` em produção sem uma decisão explícita: essa opção deixa a função acessível sem um JWT válido.

6. Gere o calendário inicial chamando `rebuild-calendar` uma vez. Depois, a tela de configurações poderá chamar a mesma função quando houver mudanças de feriados ou capacidade.

## Endpoints

Todos recebem `POST` com JSON e aceitam `OPTIONS` para CORS.

| Endpoint | Entrada principal | Resultado |
|---|---|---|
| `health` | `{}` | Verifica disponibilidade da API |
| `rebuild-calendar` | `{ startDate, endDate }` | Gera/atualiza `calendar_days` |
| `plan-order` | `{ orderId, startDate?, requestedDueDate? }` | Prévia do plano, estoque, prazo e conflitos |
| `commit-order-plan` | mesmos campos + `allowInfeasible?` | Recalcula e grava programação/reservas |

## Teste local do cálculo

O planejador é puro e não depende de Supabase:

```bash
npm test
```

As funções que acessam banco precisam de um projeto Supabase para execução real. O acesso totalmente aberto é uma decisão de negócio da fase inicial: qualquer pessoa com a URL pode chamar as funções. RLS, validações, auditoria e soft delete reduzem o risco, mas não substituem login, rate limit, backups e revisão de permissões antes de uso em produção.
