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

O Supabase ativo já contém as migrations 001–012. A 012 atualiza a regra de
alocação das posições. Os arquivos ficam em `database/` e não são executados
automaticamente pelo `supabase db push`.

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
guarda etapas e horários exatos; `allocations` reserva a posição desde a
concretagem até o fim da cura. A validação no banco confere se o item tem os
moldes adequados ao seu tipo e impede intervalos sobrepostos na mesma posição.

As regras aprovadas de concretagem e cura estão em `calculation_constants`.
Minutos de produção por unidade devem ser configurados separadamente por tipo
de peça. Não insira valores fictícios: os valores PRELUX ainda serão fornecidos.
Capacidade diária continua em `calendar_settings`.

`orders.work_id` é opcional. Quando há obra, triggers existentes sincronizam o
cliente e a data de início; sem obra, esses dados são informados no pedido.
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
