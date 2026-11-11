# Fábio II — revisão da Etapa 5

Este documento registra as decisões já esclarecidas e as pendências que afetam a migration `database/009_fabio2_foundation.sql`. A migration continua sendo uma proposta local e não foi aplicada ao Supabase ativo.

## Decisões esclarecidas

- Compatibilidade de moldes: BRAÇO fixo produz somente braço; LEITO combinado com LATERAL pode produzir pilar ou viga.
- Placa: não usa forma; X é largura, Y é altura e Z é espessura. As três dimensões participam do volume e do peso automático `X × Y × Z × 2,5 t/m³`.
- Catálogo: `mold_catalog` é global e compartilhado. A exigência de `organization_id` aplica-se às tabelas pertencentes a cada organização, não a esse catálogo global.
- Posição: guarda uma configuração dimensional do catálogo (BRAÇO ou LEITO + LATERAL); não reserva um exemplar físico individual por `molds.id`.
- Distribuição de engenharia: cada seção recebe parte dos itens, e a soma por item deve ser exatamente a quantidade pedida.
- A aplicação segue sem login. O identificador da organização deve ser definido no servidor; o navegador não deve escolher o `organization_id` nem receber a chave `service_role`.
- Os status vigentes de pedido não incluem `concluido`. A proposta preserva pedidos históricos com esse status e impede que novas gravações usem o valor legado.
- Após existir um projeto, alterações nos itens do pedido e sua distribuição em seções são salvas juntas, na mesma transação.

## Decisões ainda necessárias

1. **Etapas finais:** concretagem e cura têm tempos definidos; acabamento, inspeção e liberação ainda não têm durações. Sem elas, não há previsão confiável de liberação final.
2. **Início do turno:** `08:00` é apenas o padrão editável da proposta, ainda sem confirmação do horário real da fábrica.
3. **Pedidos antigos `concluido`:** permanecem preservados. Antes de editar um desses pedidos, seu status deve ser atualizado para um status vigente; a regra de conversão em lote não foi definida.
4. **Etiquetas:** validar coordenadas requer o PNG-modelo e suas dimensões de impressão. Também falta escolher se os dados preenchidos serão persistidos ou se o resultado será somente baixado ou impresso.
5. **Esquema em produção:** comparar esta proposta com o schema efetivamente aplicado e o histórico de migrations do Supabase antes de qualquer alteração no banco ativo. O resumo no repositório não substitui essa verificação.

## Modelo atual da proposta

- `piece_mold_combinations` é uma view: apresenta os braços fixos e gera LEITO × LATERAL para pilar/viga sem persistir cada par como um molde físico.
- Uma posição recebe uma configuração de BRAÇO, um par LEITO/LATERAL ou a configuração plana `placa`; não é feita reserva de um exemplar físico individual.
- A divisão completa dos itens do pedido entre seções é gravada pela RPC `save_engineering_project_structure` em uma transação; a soma por item deve fechar exatamente a quantidade pedida. Quando o pedido já possui projeto, `save_order_with_project` atualiza pedido, itens e seções juntos na mesma transação.
- `production_orders` representa unidades planejadas; `production_order_steps` registra etapas e horários; `allocations` reserva a posição durante concretagem e cura. O tratamento de planejamentos antigos sem horários exatos deve ser preservado conforme a regra descrita em `database/ER.md`.
- `production_schedules` permanece como resumo legado.

## Limite de publicação

Esta revisão não aplica a migration 009, não publica Edge Functions e não altera o projeto Supabase ativo. Primeiro devem ser fechadas as decisões pendentes e revisado o schema ativo; depois disso, a migration e a integração podem ser atualizadas e apresentadas para revisão.
