# PRELUX / Fábio II — Etapa 3: calendário de previsão

Esta etapa liga a área **Planejamento** à API `simulate-production` da Etapa 2. O calendário continua com visões **mês**, **semana** e **Gantt**, agora incluindo preparação de forma, concretagem, cura e acabamento previstos pelo motor novo.

## Como usar

1. Abra **Planejamento**. Pedidos aprovados entram automaticamente na fila calculada pelo servidor.
2. Marque um ou mais orçamentos em **Simulação de produção** e escolha **Atualizar simulação**. A resposta junta esses orçamentos à fila aprovada e recalcula datas e posições.
3. Confira, para cada pedido, o último acabamento, o limite de 90 dias, o excesso de prazo e a quantidade que cabe no limite. O indicador de maior carga mostra a posição com mais dias de preparação e concretagem.
4. Navegue por mês, semana ou Gantt. Preparação e concretagem ocupam a posição. A cura é exibida fora da posição, e o acabamento aparece no primeiro dia útil depois dela. Orçamentos selecionados têm borda tracejada para indicar hipótese.

**A simulação não grava reservas.** As alocações de pedidos com produção já iniciada aparecem a partir do banco. Planos antigos ainda pendentes são omitidos das visões para não misturar a antiga regra de cura na posição com a previsão nova. O botão antigo de confirmação e o reagendamento por arraste não são oferecidos nesta etapa. A confirmação transacional da nova fila faz parte da integração posterior de planejamento e produção.

## Arquivos

| Caminho | Responsabilidade |
|---|---|
| `dist/js/repositories/planning-repository.js` | Chama a API de simulação. |
| `dist/js/features/planning/scenario-calendar.js` | Traduz unidades previstas para o calendário e calcula ocupação por posição. |
| `dist/js/features/planning/index.js` | Mantém a seleção de orçamentos e renderiza mês, semana, Gantt e resumo. |
| `dist/index.html`, `dist/css/app.css` | Painel de simulação, legendas e apresentação. |
| `dist/sw.js`, `dist/js/main.js` | Atualizam o cache do PWA. |

## Verificação

Execute `npm test` e `npm start`; abra `http://127.0.0.1:4173`, depois **Planejamento**. O teste de `scenario-calendar` cobre o caso em que P01 prepara de 05 a 09/01/2026, concreta em 12/01, cura em 13–14/01 fora da posição e acaba em 15/01. Também verifica que uma previsão substitui planos antigos pendentes, preservando os registros de pedidos já iniciados.

Em 12/11/2026, a suíte local passou com **38 testes**. O servidor respondeu HTTP 200 para a página, o CSS e o novo módulo. A verificação automatizada não controlou um navegador gráfico neste ambiente.

## Limites para a próxima integração

- A API `simulate-production` continua somente leitura. Aprovar um pedido exige, na etapa de gravação, revalidar a fila e persistir reserva, preparação e alocação em uma transação.
- O banco e as rotas legadas de confirmação ainda mantêm intervalos antigos até o fim da cura. Esta etapa retira o acesso a essa confirmação na interface de Planejamento; a migração conjunta do banco e do fluxo de produção fica para a etapa posterior.
- O indicador de gargalo representa a posição com mais dias ocupados no cenário. Não mede capacidade de pátio, mão de obra ou estoque.
