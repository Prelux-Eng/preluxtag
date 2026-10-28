# Banco PRELUX · planejamento e cadastros operacionais

O banco atual é de uma unidade produtiva PRELUX. A partir da migração 006, o
planejamento de concretagem usa quatro posições físicas por dia útil; os minutos
permanecem somente como dado de registro nas programações legadas.

## Aplicação no Supabase

Execute os arquivos na ordem abaixo pelo SQL Editor ou pela CLI do Supabase:

1. `001_initial_schema.sql`
2. `002_stage2_functions.sql`
3. `003_persist_replanned_dates.sql`
4. `004_works_pieces_molds.sql`
5. `005_optional_mold_cycle.sql`
6. `006_position_based_planning.sql`
7. `007_stage4_piece_catalog_positions.sql`

Em uma instalação que já aplicou 001–005, execute `006_position_based_planning.sql`.
Ela cria P01–P04, ordens unitárias, alocações por posição, ajustes manuais de
prazo e mantém `production_schedules` como resumo compatível com a tela atual.
Em seguida, aplique `007_stage4_piece_catalog_positions.sql` para incluir os
catálogos fixos, dimensões X/Y/Z, requisitos de molde por peça e configuração
das quatro posições. Após a migração, publique a Edge Function
`operations-admin` atualizada para habilitar os novos formulários e o vínculo
de compatibilidade com o planejador.

O script cria a organização inicial com o ID:

`11111111-1111-4111-8111-111111111111`

Esse valor deve ser configurado como `PRELUX_ORGANIZATION_ID` nas Edge Functions. O `SUPABASE_SERVICE_ROLE_KEY` deve ficar apenas no ambiente do Supabase; nunca deve ser colocado no HTML, no PWA ou no aplicativo mobile.

As tabelas estão protegidas por RLS sem policies públicas. Portanto, o navegador não fala diretamente com o banco: ele chama as Edge Functions, que validam o payload e usam a chave administrativa somente no servidor.

Regras da migração 004: a preparação do molde dura sete dias corridos e só pode ser aprovada após limpeza, desmoldante e montagem; uma produção exige preparação aprovada e compatibilidade entre molde e tipo de peça. Reservas de um mesmo molde não podem se sobrepor. Para conflitos em outro recurso, a alocação deve registrar justificativa e responsável.

A migração 006 preserva `planned_end_date` como prazo linear e registra
`forecast_end_date` separadamente. A gravação de um pedido chama o motor de
planejamento e reprograma, em uma transação, os pedidos ainda não iniciados por
data de início e ordem de cadastro. Persiste até quatro concretagens por dia
útil. `planned_minutes` continua guardado para consulta, mas não participa do
limite de capacidade.

O cadastro de tipo de peça não utiliza os campos de cura e armadura. O tempo de
produção por unidade permanece registrado e não limita a capacidade. O motor usa
dois dias corridos de cura como regra fixa desta etapa e programa acabamento no
primeiro dia útil seguinte. O ciclo antigo de cura salvo no cadastro não altera
esse cálculo.

O catálogo fixo da Etapa 4 contém LEITO 20, 25, 30, 35, 40, 50, 60 cm;
LATERAL 25, 30, 40, 50, 60 cm; e BRAÇO 25x35, 25x52, 30x60 cm. Peças Braço
selecionam um molde BRAÇO. Peças Pilar e Viga selecionam um LEITO e um LATERAL.
Cada posição recebe uma dessas configurações, e o planejador só aloca a peça em
uma posição compatível. Posições ainda sem configuração não atendem às peças
que tenham requisitos de molde cadastrados. A configuração não pode mudar
durante uma concretagem em andamento; a fila futura é recalculada ao salvar.

O tempo de setup para trocar a configuração de uma posição não foi informado e
não entra no prazo calculado. A preparação de sete dias do molde continua no
cadastro operacional existente; a liberação por preparação será conectada ao
início da produção na Etapa 5.
