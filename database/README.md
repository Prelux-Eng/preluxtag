# Banco PRELUX · schema e regras

O sistema usa Supabase/PostgreSQL. As mudanças de schema são incrementais e
preservam as tabelas de catálogo, pedido, produção e posição que já existem.

## Ordem das migrations

Em uma instalação nova, aplique os arquivos em ordem:

1. `001_initial_schema.sql`
2. `002_stage2_functions.sql`
3. `003_persist_replanned_dates.sql`
4. `004_works_pieces_molds.sql`
5. `005_optional_mold_cycle.sql`
6. `006_position_based_planning.sql`
7. `007_stage4_piece_catalog_positions.sql`
8. `008_stage5_work_order_inheritance.sql`
9. `009_fabio2_foundation.sql`
10. `010_remove_composed_geometry.sql`
11. `011_order_first_item_flow.sql`
12. `012_order_driven_position_allocation.sql`
13. `013_process_stage_timing.sql`
14. `014_order_approval_timestamp.sql`
15. `supabase/migrations/20261112173505_stage4_order_item_plate_support.sql`
16. `supabase/migrations/20261112184304_stage5_transactional_factory_plan.sql`
17. `supabase/migrations/20261113115042_stage5_form_state_and_closed_orders.sql`
18. `supabase/migrations/20261113123225_stage5_ignore_cancelled_form_history.sql`
19. `supabase/migrations/20261113165527_order_completed_piece_ready.sql`
20. `supabase/migrations/20261113170020_ready_unit_protection.sql`
21. `supabase/migrations/20261113171705_order_production_labels.sql`
22. `supabase/migrations/20261116172838_delete_operation_records.sql`
23. `supabase/migrations/20261116180117_withdraw_production_unit.sql`
24. `supabase/migrations/20261116180240_fix_withdraw_production_unit_uuid.sql`
25. `supabase/migrations/20261116180601_preserve_withdrawn_cast_reservations.sql`
26. `supabase/migrations/20261117123206_delete_order_with_history.sql`
27. `supabase/migrations/20261117144307_engineering_parameter_versions.sql`
28. `supabase/migrations/20261117144318_idempotent_plan_confirmation.sql`
29. `supabase/migrations/20261117144324_label_versions_and_print_audit.sql`
30. `supabase/migrations/20261118112946_use_casting_minutes_capacity.sql`
31. `supabase/migrations/20261126122132_auto_work_piece_numbers.sql`
32. `supabase/migrations/20261127171528_allow_work_client_update.sql`

O Supabase ativo contém a estrutura descrita até a migration 032. A 012 atualiza a regra de
alocação das posições; a 013 ajusta a carga legada de concretagem. A 014
registra a ordem de aprovação para a simulação. Os arquivos ficam em `database/` e não são executados
automaticamente pelo `supabase db push`.

As migrations 027 e 028 foram aplicadas ao Supabase ativo. A 027 cria a
configuração versionada de Engenharia com os parâmetros aprovados e liga cada
pedido aprovado à versão usada. A 028 grava recibos idempotentes somente nas
confirmações explícitas do Planejamento; simulações continuam sem escrita.
Os scripts `database/015` e `database/016` são cópias de leitura dessas
migrations, cuja fonte aplicável fica em `supabase/migrations/`.

A migration 031 cria duas sequências PostgreSQL para novos cadastros: obra com
6 dígitos (`000001`) e peça com 7 dígitos (`0000001`). Os identificadores
antigos permanecem intactos. A função de cadastro reserva o próximo número
antes de gravar; uma tentativa que falhe pode deixar um intervalo na sequência.

A 022 introduz a exclusão de cadastros sem dependências históricas. A 026
permite apagar pedidos em qualquer etapa: itens, produção, etiquetas e demais
vínculos são guardados em auditoria; as posições já usadas permanecem no
histórico do Planejamento. Peças de catálogo usadas e formas com preparação ou
alocação seguem protegidas.
As migrations 023–024 permitem retirar uma unidade planejada ou em produção,
reduzem a quantidade do item e guardam as etapas executadas. A última unidade
remove o item e registra seu estado completo em auditoria; um evento independente
preserva a forma montada na posição.
A 025 mantém a ocupação do dia de concretagem na fila após retirar a última
unidade, impedindo que a posição seja oferecida novamente naquele período.

A Etapa 4 foi gerada pelo Supabase CLI no diretório padrão
`supabase/migrations/`. Ela atualiza apenas a RPC existente de inclusão de
itens: placa não exige molde e orçamento não conserva reservas. Aplique-a após
as migrations 001–014 ao recriar o schema.

## Etapa 5 — confirmação do Planejamento

A Etapa 5 adiciona uma revisão otimista do cenário e uma RPC transacional. A
Edge Function recalcula a fila no servidor; a confirmação aprova os orçamentos
selecionados e grava a fila no mesmo commit. Se os dados mudarem depois da
prévia, a revisão rejeita a confirmação e a tela deve simular novamente.

Somente reservas ainda planejadas de pedidos sem produção iniciada são
substituídas. Produção iniciada, concluída ou refugadas e suas etapas são
preservadas. Uma posição fica ocupada durante os cinco dias úteis de preparação,
quando necessária, e durante a concretagem de um dia útil; a cura de dois dias
corridos ocorre fora da posição. Quantidades sem vaga continuam aguardando.

A migration corretiva guarda `allocations.mold_catalog_codes` como retrato da
forma usada. A última concretagem concluída mantém essa forma pronta para
reuso na posição; **Desmontar forma** encerra esse estado quando não há unidade
reservada. Trocar a posição para bancada de placa também encerra o reuso.
Pedidos com início antigo começam a programação física no dia atual da unidade,
sem alterar a data original usada no prazo. Reconstruir a fila preserva as
datas de pedidos encerrados.

`factory_plan_revisions` tem RLS habilitado e sem políticas públicas. A leitura
da revisão e a RPC `commit_factory_simulation` são exclusivas do `service_role`,
usado nas Edge Functions. A rota antiga `commit-order-plan` não grava mais
programações.

## Peça pronta e pedido concluído

Na tela **Pedidos → Produzir**, o operador confirma as etapas de cada unidade na
sequência planejada. A função `complete_production_step` grava a conclusão da
etapa e libera a posição depois da concretagem. Uma unidade passa a **Pronta**
quando preparação (se houver), concretagem, cura e acabamento estão concluídos.
O pedido passa automaticamente a **Concluído** quando cada item tem exatamente
sua quantidade solicitada de unidades prontas. Um pedido vazio não pode ser
concluído. As duas mudanças ocorrem na mesma transação; o banco também impede
marcar diretamente uma unidade como pronta ou um pedido como concluído antes
dessas condições. Unidades prontas continuam protegidas contra replanejamento
e exclusão do item.

Ao concluir o pedido, a trigger cria uma linha de `production_labels` para cada
unidade pronta. `production_order_id` é a chave única: atualizar o pedido de
novo não duplica etiquetas. ID, cliente e observações impressas ficam salvos
como retrato do pedido e da peça no momento da conclusão. A tabela tem RLS
ativa, sem acesso direto para `anon` ou `authenticated`; a Edge Function lê os
registros com `service_role`. As caixas de liberação/reparo/bloqueio do modelo
impresso permanecem para conferência manual.

A migration 027 acrescenta `version_number` ao retrato atual e copia cada
etiqueta existente como versão 1 em `production_label_versions`. Uma nova
versão só é gravada quando `ensure_order_labels` encontra conteúdo diferente;
repetições idênticas continuam idempotentes. Downloads PNG, ZIP e pedidos de
impressão das etiquetas de produção passam pela Edge Function, que exige o nome
autodeclarado do operador e grava um evento por unidade em
`production_label_print_events`. A chave da solicitação evita eventos
duplicados em uma repetição de rede. O evento registra o pedido de emissão e
não confirma que uma impressora física concluiu o trabalho. O nome não é uma
identidade autenticada: o sistema permanece sem login.
Se um pedido for removido pela RPC de exclusão com auditoria, as versões e os
eventos são incluídos no histórico arquivado antes de remover as unidades.

## Moldes e posições

`mold_catalog` é o catálogo global de medidas BRAÇO, LEITO e LATERAL.
`piece_type_molds` guarda os códigos exigidos por cada tipo de peça.

- Braço: X × Z localiza o molde fixo BRAÇO correspondente; Y é o comprimento.
- Pilar e viga: X localiza o LEITO; Z localiza a LATERAL; Y é o comprimento.
- Z é a espessura usada no cálculo dimensional já existente.
- `piece_mold_combinations` lista as opções válidas do catálogo; os pares não
  são duplicados como moldes físicos.

`mold_positions` representa os quatro espaços físicos P01–P04. Uma posição não
fica presa a uma configuração de forma: o item do pedido determina as formas e
o planejador associa o item à posição livre durante o período reservado. Uma
posição fica indisponível enquanto estiver em manutenção ou ocupada por outra
alocação no mesmo intervalo. A exceção é a posição marcada como bancada plana,
reservada para produzir placas sem forma. A gravação da posição mantém status,
observações e, quando necessário, essa marca de bancada; os antigos códigos de
forma ficam no schema por compatibilidade e histórico.

Nesta etapa, a alocação associa códigos do catálogo ao item e à posição, sem
reservar uma instância física específica de `molds.id`. O cadastro físico de
moldes continua separado do catálogo de medidas.

## Produção e planejamento

`production_orders` representa cada unidade do item. `production_order_steps`
guarda etapas e horários exatos; `allocations` reserva a posição desde o início
da preparação (se necessária) até o fim da concretagem. A cura ocorre fora da
posição. A validação no banco confere os moldes, impede concretagens duplicadas
no mesmo dia e bloqueia intervalos sobrepostos.

O catálogo já guarda `production_minutes_per_unit`; o snapshot do item e de cada
unidade define a duração ativa da concretagem. O simulador soma esses minutos
contra a capacidade diária do calendário e usa o snapshot para calcular o fim
exato da concretagem. Cura por dois dias corridos e acabamento por um turno útil
continuam como etapas separadas. A regra de uma concretagem por posição/dia e o
teto diário de concretagens da Engenharia também continuam valendo.

Pedidos em orçamento são entradas da simulação sem gravação de reserva. Na
confirmação, os orçamentos selecionados são aprovados junto com a fila recalculada.
Uma quantidade sem vaga pode continuar aguardando posição.

`orders.work_id` é opcional. Quando há obra, os pedidos herdam o cliente e a
data de início. Alterar o cliente da obra sincroniza os pedidos vinculados,
mesmo que já estejam em produção; alterar a data de início continua bloqueado
depois que a produção começa. Sem obra, cliente e início são informados no pedido.
O fluxo sem login continua usando Edge Functions públicas com `service_role`
somente no servidor; RLS não concede escrita direta ao navegador.

## Aplicação de migrations

Leia cada migration completa antes de aplicá-la ao projeto ativo. Para a base
PRELUX em uso, aplique somente migrations que ainda não aparecem no histórico do
Supabase. Preserve pedidos, catálogo, posições, produção e histórico existentes.

O identificador inicial da organização de PRELUX é
`11111111-1111-4111-8111-111111111111`. Configure-o no servidor como
`PRELUX_ORGANIZATION_ID`. A chave `SUPABASE_SERVICE_ROLE_KEY` nunca deve ser
incluída no front-end nem em arquivos versionados.

## Nova reestruturação · Etapa 2

As migrations 027–029 já constam no histórico do Supabase ativo. Elas criam
versões dos parâmetros de Engenharia, recibos idempotentes de confirmação e
versionamento/auditoria das etiquetas, sem apagar registros operacionais.

A migration `supabase/migrations/20261118112946_use_casting_minutes_capacity.sql`
(espelhada em `database/017_use_casting_minutes_capacity.sql`) acrescenta o
snapshot de minutos ao histórico de unidades retiradas e valida o total diário
de `production_schedules.planned_minutes` contra o calendário. Também impede
reduzir a capacidade de um dia abaixo de minutos já programados. Ela foi
aplicada ao Supabase ativo; as funções `simulate-production` v10,
`confirm-production-plan` v8 e `plan-order` v5 foram publicadas com validação
JWT habilitada.
