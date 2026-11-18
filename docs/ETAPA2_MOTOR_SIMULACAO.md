# PRELUX / Fábio II — Etapa 2: motor de prazo e simulação

**Estado em 17/11/2026: motor integrado; cálculo por minutos implementado localmente, ainda não aplicado ao Supabase ativo.** A interface do Planejamento chama `simulate-production` para simular e `confirm-production-plan` para revalidar e gravar a fila. No Supabase ativo, as duas funções estão publicadas (versões 9 e 7) e as migrations de confirmação e versão de Engenharia estão aplicadas.

## Regras aplicadas

1. Pedidos **aprovados** têm prioridade pela hora de aprovação; itens seguem a sequência do pedido. Orçamentos selecionados entram depois na simulação e não reservam capacidade real.
2. Há quatro posições P01–P04. Cada posição disponível faz no máximo **uma concretagem por dia útil**. Posição de placa recebe somente placa.
3. Uma forma já montada e compatível dispensa preparação. Trocar/instalar BRAÇO ou LEITO+LATERAL reserva **cinco dias úteis** na posição. A configuração continua pronta até outra troca.
4. Cada concretagem usa os minutos por unidade congelados no pedido. A soma das concretagens do dia não pode exceder a capacidade em minutos do calendário; continuam valendo o máximo de concretagens por dia e uma concretagem por posição/dia. A posição é liberada ao fim da concretagem. Cura por **dois dias corridos** ocorre fora dela; acabamento ocupa o turno do primeiro dia útil depois da cura.
5. O prazo máximo é início + **90 dias corridos**. A resposta mostra data prevista, excesso em dias, prazo solicitado inviável e quantas unidades terminam dentro dos 90 dias. Ajustes de atraso registrados são somados à previsão, sem mudar a sequência base.
6. Dimensões em centímetros preservam a fórmula prismática: `Vcm³ = X×Y×Z`, `Vm³ = Vcm³/1.000.000`, `P_kg = Vcm³×2,5/1.000`. Tipos legados sem dimensões retornam métricas nulas, sem inventar valores.

**Tempo por etapa:** `production_minutes_snapshot` representa o tempo ativo de concretagem por unidade e agora é descontado da capacidade diária. O mesmo snapshot define o horário exato de fim da concretagem. Cura, preparação e acabamento mantêm suas durações próprias e não consomem os minutos de concretagem. A preparação continua ocupando a posição por cinco dias úteis até a concretagem; cura acontece fora dela. A regra de preparo coincide com a versão publicada que o usuário pediu para preservar.

Reservas anteriores com snapshot de minutos conhecido descontam sua carga do dia. Retiradas antigas sem esse retrato conservam a regra segura de bloquear a capacidade do turno inteiro. A migration local valida a soma de `production_schedules.planned_minutes` por dia, impede reduzir a capacidade abaixo da carga já programada e grava os minutos no histórico de unidades retiradas.

## Arquivos e contratos

| Arquivo | Papel |
|---|---|
| `supabase/functions/_shared/factory-simulator.js` | Motor puro que agenda preparação, concretagem, cura e acabamento entre pedidos. |
| `supabase/functions/_shared/factory-simulation-service.js` | Lê pedidos, itens, catálogo, posições, calendário, ajustes e ocupações já iniciadas. Não faz INSERT/UPDATE/UPSERT. |
| `supabase/functions/simulate-production/index.ts` | `POST /functions/v1/simulate-production`. |
| `database/014_order_approval_timestamp.sql` | Adiciona `orders.approved_at`, trigger e índice para a prioridade real. |
| `tests/factory-simulator.test.mjs` | Cenários de prazo, compatibilidade, capacidade e leitura sem escrita. |

Entrada: `{"orderIds":["<uuid-1>","<uuid-2>"]}`. Pode-se informar um único `orderId` por compatibilidade; até 30 pedidos por chamada. O backend acrescenta à simulação todos os pedidos aprovados ainda reprogramáveis. A resposta tem `ok: true` e `scenario.orders[]` com unidades, preparação, datas, volume/peso, `overLimitDays`, `maximumQuantityWithin90Days` e `suggestedDueDate`. `scenario.positionUsage` e `scenario.bottleneck` mostram a posição mais ocupada no cenário. Um pedido iniciado não pode ser reprogramado; suas alocações existentes bloqueiam capacidade.

`simulate-production` é somente leitura e não grava calendário nem reservas. A confirmação é uma ação separada: `confirm-production-plan` recalcula o cenário no servidor, usa uma chave idempotente e grava o plano em uma transação, preservando unidades já iniciadas. A interface já chama as duas funções pelo repositório de Planejamento.

## Casos de teste com resultados esperados

Calendário de segunda a sexta, sem feriados, início em **05/01/2026**:

| Cenário | Resultado esperado |
|---|---|
| Pedido isolado de 5 vigas; quatro posições já prontas | Quatro concretagens em 05/01, uma em 06/01; último acabamento em **09/01**. |
| Forma pronta, 2 vigas em uma posição | Sem preparação; concretagens em **05/01 e 06/01**, mesmo com a primeira peça em cura. Acabamentos em 08/01 e 09/01. |
| Forma não pronta, 1 viga em uma posição | Preparação **05–09/01** (cinco dias úteis); concretagem **12/01**, cura 13–14/01, acabamento **15/01**. |
| 70 vigas em uma posição pronta | Último acabamento **13/04**; limite **05/04**; excesso **8 dias**; **62 unidades** cabem no limite. |
| Um pedido aprovado e um orçamento simultâneos, mesma posição pronta | Aprovado concreta **05/01**; orçamento concreta **06/01** no cenário e não reserva capacidade real. |
| Feriado em 08/01 | Cura da peça concretada em 05/01 termina em 07/01; acabamento passa para **09/01**. |

Executar: `node --test`. Os testes do motor cobrem capacidade diária por minutos, soma de tipos diferentes, carga de reservas existentes, conflito quando uma unidade excede o turno, horário real de fim da concretagem, preparo de cinco dias, cura fora da posição, limite de 90 dias, prioridade de aprovados, orçamentos apenas simulados e ajustes externos.

## Limites e próximos vínculos

- A simulação e a confirmação transacional já estão integradas na tela do Planejamento. `plan-order` e `commit-order-plan` permanecem como rotas de compatibilidade; a tela principal usa `confirm-production-plan`.
- Uma posição marcada `em_preparacao`, `em_producao` ou `em_manutencao` é tratada como indisponível até haver data confiável de liberação. Não há ainda reserva persistente de preparação por posição.
- Mudanças nas fontes incrementam `factory_plan_revisions`, o que rejeita uma confirmação baseada em cenário desatualizado. Isso não equivale a um fluxo geral de eventos em tempo real; a tela ainda precisa recarregar/recalcular após mudanças externas.
- O gargalo exibido é a posição com mais dias ocupados no cenário; é um indicador de carga, não uma análise completa de produtividade da fábrica.
- O fim calculado é o **último acabamento**, conforme regra recebida. Desforma por resistência, inspeção, estoque, expedição e montagem exigem critérios e tempos próprios antes de prometer uma data contratual de entrega física.
- Alterar a data de início não garante reduzir uma duração maior que 90 dias quando o limite acompanha o próprio início; por isso a API oferece a quantidade que cabe no limite e a data prevista viável.

Verificação em 18/11/2026: a migration `20261118112946_use_casting_minutes_capacity` consta no histórico do Supabase ativo e `withdrawn_unit_form_events.production_minutes_snapshot` está presente. As funções estão ativas: `simulate-production` v10, `confirm-production-plan` v8 e `plan-order` v5, todas com validação JWT habilitada. A consulta encontrou quatro triggers relacionados às tabelas de capacidade e histórico e nenhuma reserva ativa no momento da verificação. A simulação é leitura; a confirmação grava as reservas solicitadas pela interface.
