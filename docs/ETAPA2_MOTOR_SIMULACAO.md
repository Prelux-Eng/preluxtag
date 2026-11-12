# PRELUX / Fábio II — Etapa 2: motor de prazo e simulação

**Implementado em 12/11/2026.** Esta etapa acrescenta uma API de simulação sem escrita. O fluxo de cadastro e a confirmação de planos do site ainda usam o planejador anterior; a interface e a gravação da nova fila pertencem às próximas etapas.

## Regras aplicadas

1. Pedidos **aprovados** têm prioridade pela hora de aprovação; itens seguem a sequência do pedido. Orçamentos selecionados entram depois na simulação e não reservam capacidade real.
2. Há quatro posições P01–P04. Cada posição disponível faz no máximo **uma concretagem por dia útil**. Posição de placa recebe somente placa.
3. Uma forma já montada e compatível dispensa preparação. Trocar/instalar BRAÇO ou LEITO+LATERAL reserva **cinco dias úteis** na posição. A configuração continua pronta até outra troca.
4. Concretagem ocupa um dia útil. A peça sai da posição após esse dia; cura por **dois dias corridos** fora dela. Acabamento ocorre no primeiro dia útil seguinte e ocupa um dia útil.
5. O prazo máximo é início + **90 dias corridos**. A resposta mostra data prevista, excesso em dias, prazo solicitado inviável e quantas unidades terminam dentro dos 90 dias. Ajustes de atraso registrados são somados à previsão, sem mudar a sequência base.
6. Dimensões em centímetros preservam a fórmula prismática: `Vcm³ = X×Y×Z`, `Vm³ = Vcm³/1.000.000`, `P_kg = Vcm³×2,5/1.000`. Tipos legados sem dimensões retornam métricas nulas, sem inventar valores.

**Representação do tempo:** “um dia útil de concretagem” é uma vaga diária, não 24 horas nem um número presumido de minutos de turno. Os campos antigos de 120 minutos e 12 horas permanecem no planejador antigo; o novo simulador não usa essas durações.

## Arquivos e contratos

| Arquivo | Papel |
|---|---|
| `supabase/functions/_shared/factory-simulator.js` | Motor puro que agenda preparação, concretagem, cura e acabamento entre pedidos. |
| `supabase/functions/_shared/factory-simulation-service.js` | Lê pedidos, itens, catálogo, posições, calendário, ajustes e ocupações já iniciadas. Não faz INSERT/UPDATE/UPSERT. |
| `supabase/functions/simulate-production/index.ts` | `POST /functions/v1/simulate-production`. |
| `database/014_order_approval_timestamp.sql` | Adiciona `orders.approved_at`, trigger e índice para a prioridade real. |
| `tests/factory-simulator.test.mjs` | Cenários de prazo, compatibilidade, capacidade e leitura sem escrita. |

Entrada: `{"orderIds":["<uuid-1>","<uuid-2>"]}`. Pode-se informar um único `orderId` por compatibilidade; até 30 pedidos por chamada. O backend acrescenta à simulação todos os pedidos aprovados ainda reprogramáveis. A resposta tem `ok: true` e `scenario.orders[]` com unidades, preparação, datas, volume/peso, `overLimitDays`, `maximumQuantityWithin90Days` e `suggestedDueDate`. `scenario.positionUsage` e `scenario.bottleneck` mostram a posição mais ocupada no cenário. Um pedido iniciado não pode ser reprogramado; suas alocações existentes bloqueiam capacidade.

Não existe ação de confirmação nesta rota. Clicar em “simular” não grava `calendar_days`, alocações, fila nem snapshots. Uma etapa posterior deve revalidar o cenário no banco e gravar preparação e alocações em uma transação, preservando as unidades já iniciadas.

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

Executar: `node --test`. Resultado local em 12/11/2026: **36 testes aprovados**. Uma verificação HTTP da função publicada com um orçamento existente retornou `ok: true`, 15 unidades, preparação a partir de 12/11/2026 e primeira concretagem em 19/11/2026. A verificação não gravou pedido nem plano.

## Limites e próximos vínculos

- A API nova está publicada, mas as telas e `plan-order`/`commit-order-plan` ainda chamam o planejamento anterior. Portanto, o **site ainda não usa este novo prazo na gravação**. A integração precisará adaptar o banco: hoje a constraint de alocação mantém a posição até o fim da cura.
- Uma posição marcada `em_preparacao`, `em_producao` ou `em_manutencao` é tratada como indisponível até haver data confiável de liberação. Não há ainda reserva persistente de preparação por posição.
- O gargalo exibido é a posição com mais dias ocupados no cenário; é um indicador de carga, não uma análise completa de produtividade da fábrica.
- O fim calculado é o **último acabamento**, conforme regra recebida. Desforma por resistência, inspeção, estoque, expedição e montagem exigem critérios e tempos próprios antes de prometer uma data contratual de entrega física.
- Alterar a data de início não garante reduzir uma duração maior que 90 dias quando o limite acompanha o próprio início; por isso a API oferece a quantidade que cabe no limite e a data prevista viável.

Não foram alterados os dois pedidos nem as 15 unidades existentes. A migration 014 adicionou apenas a hora de aprovação; os dois pedidos permaneceram em orçamento.
