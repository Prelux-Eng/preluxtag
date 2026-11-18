# PRELUX / Fábio II — Etapa 3: calendário de previsão

Esta etapa liga a área **Planejamento** ao motor `simulate-production` e à confirmação transacional `confirm-production-plan`. O calendário mantém visões **mês**, **semana** e **Gantt**, com preparação de forma, concretagem, cura e acabamento.

## Como usar

1. Abra **Planejamento**. Pedidos aprovados entram automaticamente na fila calculada pelo servidor.
2. Marque um ou mais orçamentos em **Simulação de produção** e escolha **Atualizar simulação**. A resposta junta esses orçamentos à fila aprovada e recalcula datas e posições.
3. Confira, para cada pedido, o último acabamento, o limite de 90 dias, o excesso de prazo e a quantidade que cabe no limite. O indicador de maior carga mostra a posição com mais dias de preparação e concretagem.
4. Confirme o cenário para o servidor recalcular a fila e gravar as reservas de forma idempotente. Se os dados mudarem entre simulação e confirmação, o banco rejeita o cenário antigo para evitar uma gravação inconsistente.
5. Navegue por mês, semana ou Gantt. A preparação ocupa P01–P04 por cinco dias úteis quando a forma precisa ser trocada; a posição permanece ocupada até o fim da concretagem. Os minutos de cada peça são somados contra a capacidade diária do calendário, sem retirar a regra de uma concretagem por posição/dia. A cura é exibida fora da posição, e o acabamento aparece no primeiro dia útil depois dela. Orçamentos selecionados têm borda tracejada para indicar hipótese.

**Simular não grava reservas; confirmar grava.** As alocações de pedidos com produção já iniciada permanecem preservadas. Pedidos orçados entram apenas na simulação até a confirmação explícita; pedidos aprovados reservam capacidade. O repositório gera uma chave idempotente para repetir uma confirmação após falha de rede sem duplicar a fila.

## Arquivos

| Caminho | Responsabilidade |
|---|---|
| `dist/js/repositories/planning-repository.js` | Chama a API de simulação. |
| `dist/js/features/planning/scenario-calendar.js` | Traduz unidades previstas, minutos e horários de concretagem para o calendário. |
| `dist/js/features/planning/index.js` | Mantém a seleção de orçamentos e renderiza mês, semana, Gantt, carga diária e resumo. |
| `dist/index.html`, `dist/css/app.css` | Painel de simulação, legendas e apresentação. |
| `dist/sw.js`, `dist/js/main.js` | Atualizam o cache do PWA. |

## Verificação

Execute `npm test` e `npm start`; abra `http://127.0.0.1:4173`, depois **Planejamento**. O teste de `scenario-calendar` cobre o caso em que P01 prepara de 05 a 09/01/2026, concreta em 12/01, cura em 13–14/01 fora da posição e acaba em 15/01. Também verifica que uma previsão substitui planos antigos pendentes, preservando os registros de pedidos já iniciados.

O projeto ativo usa `simulate-production` v10, `confirm-production-plan` v8 e `plan-order` v5. A migration `20261118112946_use_casting_minutes_capacity` valida a soma diária de minutos no Supabase. A interface apresenta a carga diária em horas/minutos e a duração de cada unidade; o tooltip mostra o horário previsto de início e fim da concretagem no fuso da fábrica. O cache do PWA avançou para v30. O Site público está atualizado na versão 45.

## Limites para a próxima integração

- O motor limita cada posição a uma concretagem por dia útil, respeita o teto de concretagens da Engenharia e soma minutos de concretagem contra a capacidade diária global configurada. Cura e acabamento seguem calendários próprios; preparação continua reservando a posição até a concretagem.
- O indicador de gargalo representa a posição com mais dias ocupados no cenário. Não mede capacidade de pátio, mão de obra ou estoque.
