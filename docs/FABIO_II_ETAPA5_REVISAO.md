# Fábio II — revisão da Etapa 5

## Escopo desta etapa

Ligar a simulação diária da produção à confirmação das reservas nas quatro
posições P01–P04, sem substituir o catálogo, os pedidos ou as tabelas de
produção que já existem no Supabase.

## Regras confirmadas

- Pedidos em orçamento podem ser simulados, mas não reservam capacidade.
- A confirmação de orçamento acontece na área Planejamento; ela aprova os
  pedidos selecionados e grava as reservas na mesma transação.
- A fila aprovada é recalculada no servidor. A tela não envia horários como
  dados confiáveis para persistência.
- Se a forma não estiver pronta na posição, a preparação ocupa cinco dias
  úteis. A posição continua pronta para a mesma configuração até ser trocada
  ou desmontada explicitamente.
- A concretagem ocupa a posição por um dia útil. A cura ocupa dois dias
  corridos fora da posição. O acabamento usa o primeiro dia útil após a cura.
- Quantidades sem posição disponível podem ser confirmadas parcialmente e ficam
  aguardando capacidade.
- A alteração da fila não apaga unidades iniciadas, concluídas ou refugadas.
- A aplicação continua sem login e usa Edge Functions com `service_role`
  exclusivamente no servidor; não foram criadas políticas RLS públicas.

## Persistência e concorrência

`factory_plan_revisions` registra mudanças nas fontes da simulação e nos dados
persistidos da fila. A simulação lê uma revisão antes do cálculo e a confere ao
terminar. A RPC `commit_factory_simulation` bloqueia a organização, compara a
revisão e, se ela ainda for atual, aprova os orçamentos escolhidos, remove
reservas planejadas substituíveis e grava etapas, alocações e resumos no mesmo
commit do banco. Um cenário desatualizado retorna conflito para a interface
recalcular.

A validação de alocação continua conferindo a compatibilidade entre braço,
leito, lateral, placa e posição. Para novas linhas, a reserva começa no início
da preparação ou da concretagem e termina com a concretagem. O banco continua
aceitando a janela antiga nas alocações históricas.

## Arquivos principais

- `supabase/migrations/20261112184304_stage5_transactional_factory_plan.sql`
- `supabase/migrations/20261113115042_stage5_form_state_and_closed_orders.sql`
- `supabase/migrations/20261113123225_stage5_ignore_cancelled_form_history.sql`
- `supabase/functions/_shared/factory-simulator.js`
- `supabase/functions/_shared/factory-simulation-service.js`
- `supabase/functions/_shared/factory-plan-service.js`
- `supabase/functions/confirm-production-plan/index.ts`
- `dist/js/features/planning/index.js`
- `dist/js/repositories/planning-repository.js`

## Estado da implantação

As três migrations da Etapa 5 estão aplicadas. A RPC de confirmação está
restrita ao `service_role`. As Edge Functions de simulação, confirmação e
cadastros estão ativas; a versão 35 do Site foi publicada com acesso público.
As 15 unidades e alocações planejadas já existentes permaneceram no banco.
