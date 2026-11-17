# PRELUX / Fábio II — Etapa 3: domínio Projeto

**Estado:** concluída localmente para revisão. A migration 015 e as mudanças das Edge Functions ainda não foram aplicadas ou publicadas.

## Responsabilidades

- `project-domain.js` é o domínio puro: recebe calendário, posições, reservas, pedidos, itens e parâmetros de Engenharia; devolve fila, datas, conflitos, métricas e explicações. Não acessa Supabase, HTTP, navegador nem relógio.
- `factory-simulation-service.js` é o adaptador de leitura. Busca dados no Supabase, resolve as versões técnicas por pedido e chama Projeto.
- `factory-simulator.js` preserva a exportação antiga como compatibilidade para consumidores existentes; a implementação passou para `project-domain.js`.
- `production-phases.js` converte as datas previstas em etapas com horários locais e intervalos UTC para a confirmação do Planejamento.

## Versão da Engenharia usada

- Pedido aprovado usa `orders.engineering_parameter_version_id`. Alterar parâmetros depois não muda os cálculos do pedido aprovado.
- Orçamento selecionado para simulação ainda não tem versão aprovada; usa a versão atual, sem gravar reserva.
- A resposta identifica o ID e o número da versão em cada pedido e devolve os parâmetros usados.
- A métrica de peso usa a densidade daquela versão. O cálculo de volume continua `X × Y × Z ÷ 1.000.000`, com dimensões em centímetros.
- A preparação, a cura, a capacidade diária, o limite do pedido e o horário inicial são lidos da versão. Concretagem e acabamento permanecem em um dia útil cada, como no fluxo de etapas atualmente persistido; validação JavaScript e RPC recusam valores incompatíveis.
- Cada inserção de uma nova versão incrementa `factory_plan_revisions`, impedindo confirmar uma simulação calculada com parâmetros que mudaram durante o processo.

## Fila e cálculo

Pedidos aprovados são processados antes de orçamentos; aprovados seguem a hora de aprovação e itens seguem a sequência do pedido. Um molde já pronto dispensa preparação. Uma troca ocupa a posição pelos dias úteis configurados. P01–P04 recebem no máximo uma concretagem por dia útil e o limite diário total vem da versão de Engenharia. A cura acontece fora da posição em dias corridos; o acabamento ocupa o primeiro dia útil após a cura. Placa usa apenas a posição plana.

Cada unidade prevista informa a posição, códigos de forma, preparação necessária e motivo, datas de concretagem/cura/acabamento, horário inicial, volume e peso. Se não houver capacidade no horizonte ou o calendário não alcançar o acabamento, a resposta inclui conflito em vez de inventar uma data.

Ajustes externos mantêm motivo, data e impacto no resultado. O impacto acumulado desloca a previsão final em dias corridos, sem alterar a sequência-base nem as datas planejadas das unidades. A interface do Planejamento passa a mostrar o motivo junto à previsão ajustada.

## Cenários cobertos

Calendário de segunda a sexta, sem feriados, início em 05/01/2026:

| Caso | Resultado verificado |
| --- | --- |
| Pedido isolado de cinco vigas em quatro posições prontas | Quatro concretagens em 05/01, uma em 06/01; último acabamento em 09/01. |
| Forma pronta para duas unidades | Sem preparação; concretagens em 05 e 06/01; cura não retém a posição. |
| Preparação necessária | Com cinco dias úteis, prepara de 05 a 09/01 e concreta em 12/01; com versão de três dias, prepara de 05 a 07/01 e concreta em 08/01. |
| Prazo acima de 90 dias | Para 70 unidades em uma posição pronta: acabamento final em 13/04, limite 05/04, excesso de 8 dias e 62 unidades dentro do prazo. |
| Dois pedidos simultâneos | Pedido aprovado recebe capacidade antes do orçamento; o orçamento só simula e não reserva. |
| Ajuste externo de +3 dias | Acabamento-base 08/01 continua intacto; previsão ajustada passa para 11/01 e mostra o motivo registrado. |

## Integridade e implantação

A etapa não executa gravações no Supabase. A implementação depende da tabela `engineering_parameter_versions` e da coluna `orders.engineering_parameter_version_id`, previstas em `database/015_engineering_parameter_versions.sql`. Portanto, não publique as Edge Functions antes de aplicar essa migration. O trigger de revisão pressupõe a função `touch_factory_plan_revision()` já instalada pela Etapa 5.

A Etapa 5 original continua concluída no histórico do projeto. Esta Etapa 3 pertence à sequência nova da reestruturação.

## Verificação local

Comando executado:

```powershell
node --test
```

Resultado: **57 testes aprovados, 0 falhas**.
