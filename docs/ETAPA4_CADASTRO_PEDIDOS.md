# PRELUX / Fábio II — Etapa 4: entrada de pedidos e peças

## Escopo

A Etapa 4 conecta o recebimento do pedido ao cadastro de itens e às posições de
produção. Obras, pedidos, catálogo de moldes e posições existentes são
reaproveitados. A etapa não recria tabelas nem remove registros.

## Fluxo de entrada

1. O operador salva a obra e o cabeçalho do pedido; o cliente e a data seguem a
   obra quando há vínculo.
2. O pedido inicia como orçamento. Os itens podem ser incluídos em seguida.
3. Ao salvar um item, o sistema grava o tipo/medidas em `piece_types`, cria o
   vínculo em `order_items` e mantém os cálculos existentes de volume e peso.
4. A tela identifica automaticamente as formas compatíveis pelo catálogo e
   informa se existe posição do tipo necessário.
5. Orçamentos aparecem para simulação no Planejamento, mas não deixam posição
   reservada. Ao voltar um pedido para orçamento, alocações pendentes são
   liberadas; produções iniciadas continuam protegidas.

## Compatibilidade

| Peça | Medidas que localizam a forma | Posição |
|---|---|---|
| Braço | X × Z encontra o molde fixo BRAÇO; Y é o comprimento | Uma das posições P01–P04 configurada para formas |
| Pilar / viga | X seleciona LEITO; Z seleciona LATERAL; Y é o comprimento | Uma das posições P01–P04 configurada para formas |
| Placa | X largura, Y altura, Z espessura; sem vínculo de molde | Posição marcada como bancada plana |

Se a bancada plana não estiver cadastrada, o pedido ainda pode ser recebido; a
tela orienta o operador a configurá-la e a peça fica sem posição até o
Planejamento encontrar uma vaga compatível.

## Banco e segurança

`supabase/migrations/20261112172629_stage4_order_item_plate_support.sql`
atualiza a RPC `add_order_piece_item`. A placa não cria linhas artificiais em
`piece_type_molds`. Para orçamento, a RPC limpa apenas reservas pendentes do
próprio pedido e informa `simulatedOnly`; ela não mexe nas tabelas do catálogo
nem nos dados históricos de peças e posições.

A RPC continua executável apenas por `service_role`; o navegador envia os dados
à Edge Function `operations-admin`. Não foi criada policy de escrita direta
para `anon`.

## Limite da próxima etapa

A aprovação ainda passa pelo planejador legado de gravação. O novo simulador
diário já oferece o cálculo de preparação, concretagem, cura fora da posição e
acabamento, mas a confirmação transacional desse cenário é uma etapa separada.
Essa conexão precisa preservar os pedidos/ordens em produção e validar
concorrência antes de substituir o planejador antigo.
