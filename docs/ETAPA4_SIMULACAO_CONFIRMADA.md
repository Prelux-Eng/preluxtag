# PRELUX / Fábio II — Etapa 4: simulação e confirmação idempotente

**Estado:** implementação local pronta para revisão. Nenhuma migration ou Edge Function foi aplicada/publicada no Supabase ativo.

## Contratos de API

### Simular sem gravar

`POST /functions/v1/simulate-production`

```json
{ "orderIds": ["uuid-do-orcamento"] }
```

A resposta reúne os pedidos aprovados reprogramáveis e os orçamentos selecionados. A simulação continua somente de leitura: não cria ordens de produção, alocações, reservas nem recibos. Pedidos aprovados usam sua versão fixada de Engenharia; orçamentos usam a versão vigente para a hipótese.

### Confirmar uma vez, mesmo com repetição de rede

`POST /functions/v1/confirm-production-plan`

```json
{
  "confirmScenario": true,
  "orderIds": ["uuid-do-orcamento"],
  "idempotencyKey": "uuid-gerado-para-esta-tentativa"
}
```

`idempotencyKey` é obrigatório e identifica uma tentativa lógica. O repositório do navegador cria UUID e mantém a chave pendente em `sessionStorage` até receber sucesso. Uma repetição com a mesma chave e os mesmos pedidos retorna o recibo original, com `replayed: true`. Usar a chave com outra lista de pedidos retorna conflito HTTP 409.

Resposta de sucesso:

```json
{
  "ok": true,
  "scenario": {},
  "result": {},
  "replayed": false
}
```

## Integridade da confirmação

- `factory_plan_confirmation_receipts` guarda a impressão digital da solicitação e a resposta confirmada. Não guarda prévias.
- `commit_factory_simulation_idempotent` serializa repetições pela organização e chave, confere a impressão digital e chama a RPC transacional já existente.
- A reserva/aprovação e o recibo são gravados na mesma transação. Se a transação falha, nenhum recibo de sucesso permanece.
- A revisão otimista continua protegendo contra mudanças no calendário, fila, parâmetros e dados de origem entre simular e confirmar.
- RLS fica ativo, sem policies públicas. A tabela não aceita escrita direta por `anon`/`authenticated`; a RPC nova pode ser executada somente por `service_role`.
- A reconciliação interna sem confirmação explícita continua usando a RPC transacional existente, sem chave de idempotência de usuário.

## Arquivos desta etapa

- `database/016_idempotent_plan_confirmation.sql` — tabela restrita de recibos e RPC idempotente.
- `supabase/functions/_shared/factory-plan-service.js` — valida chave, consulta recibo e chama a RPC apropriada.
- `supabase/functions/confirm-production-plan/index.ts` — recebe a chave e devolve o indicador de repetição.
- `dist/js/repositories/planning-repository.js` — conserva a chave durante tentativas de rede.
- `tests/factory-plan-service.test.mjs` — chave estável, conflito de reutilização e replay sem nova gravação.

## Dependências e limites

Para ativar o fluxo integrado, aplicar primeiro o script local da Etapa 3 (`database/015_engineering_parameter_versions.sql`) e depois `database/016_idempotent_plan_confirmation.sql`, após conferir a migration ativa da RPC transacional. Em seguida, publicar `confirm-production-plan` e o site no mesmo ciclo. Nada foi executado no banco ativo nesta etapa.

O recibo guarda o cenário confirmado para que a resposta original possa ser recuperada após uma interrupção de rede. Ainda não há política de expiração; os recibos permanecem até a exclusão da organização. A tabela e o endpoint ficam restritos ao `service_role`.

## Verificação local

Comando executado:

```powershell
node --test
```

Resultado local: **61 testes aprovados, 0 falhas** (inclui os testes da Etapa 3 e as garantias de repetição da Etapa 4).
