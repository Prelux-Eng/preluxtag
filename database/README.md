# Banco PRELUX · planejamento e cadastros operacionais

O banco atual é de uma unidade produtiva PRELUX. A partir da migração 006, o
planejamento de concretagem usa quatro posições físicas por dia útil; os minutos
permanecem somente como dado de registro nas programações legadas.

## Aplicação no Supabase

Em uma instalação nova, execute os arquivos na ordem abaixo pelo SQL Editor do
Supabase. Os scripts ficam em `database/` e não são descobertos automaticamente
por `supabase db push`.

1. `001_initial_schema.sql`
2. `002_stage2_functions.sql`
3. `003_persist_replanned_dates.sql`
4. `004_works_pieces_molds.sql`
5. `005_optional_mold_cycle.sql`
6. `006_position_based_planning.sql`
7. `007_stage4_piece_catalog_positions.sql`
8. `008_stage5_work_order_inheritance.sql`
9. `009_fabio2_foundation.sql` (rascunho da Etapa 5, ainda não aplicado)

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

Regras legadas da migração 004: a preparação do molde era de sete dias corridos e só podia ser aprovada após limpeza, desmoldante e montagem. A migration 009 propõe cinco dias úteis segundo `calendar_days` e ajusta o valor `preparation_days` das formas já cadastradas de 7 para 5. Ela também preenche rótulos de medidas nas linhas existentes do histórico de posições. Não aplique 009 antes de publicar junto o fluxo de tela e serviço atualizado.

A migração 006 originalmente persistia datas de planejamento também em `orders`.
A migration 009 propõe que o planejamento grave suas datas em `production_orders`
e `allocations`, mantendo os campos do pedido como dados da entrada. O resumo
`v_order_progress` passa a derivar as datas das ordens unitárias.

O cadastro de tipo de peça mantém X/Y/Z e os cálculos existentes de volume e
peso para braço, pilar e viga. A migration 009 adiciona etapas com horários
exatos a `production_order_steps`; os tempos aprovados são 120 minutos para
concretagem e 12 horas para cura. Acabamento, inspeção e liberação ainda precisam
de durações definidas pela engenharia para o planejador calcular a liberação
final.

O catálogo fixo da Etapa 4 contém LEITO 20, 25, 30, 35, 40, 50, 60 cm;
LATERAL 25, 30, 40, 50, 60 cm; e BRAÇO 25x35, 25x52, 30x60 cm. Peças Braço
selecionam um molde BRAÇO. Peças Pilar e Viga selecionam um LEITO e um LATERAL.
Cada posição recebe uma configuração de braço ou um par leito/lateral. A posição
`placa` é uma bancada plana sem forma vinculada. O planejador só aloca peça em
configuração compatível; uma configuração não pode mudar enquanto houver
produção planejada ou em andamento vinculada à posição.

O setup para trocar a configuração de uma posição não foi informado e não entra
no prazo calculado. A preparação de cinco dias úteis usa o calendário existente.

## Etapa 5 · fundação Fábio II (migration 009 em revisão)

A etapa reaproveita `works`, `orders`, `order_items`, `piece_types`, `mold_catalog`,
`piece_type_molds`, `mold_positions`, `production_orders` e `allocations`. Não
recria nem renomeia essas tabelas; a migration 009 só altera os pontos descritos
acima e adiciona tabelas para projeto, constantes e etapas. O diagrama e as
chaves relevantes estão em [`ER.md`](ER.md).

As migrations anteriores já herdam cliente e data de início da obra no pedido.
Pedido sem obra continua aceitando cliente e data informados manualmente.

As sugestões vêm do catálogo existente: as opções fixas de BRAÇO e todas as
combinações LEITO × LATERAL para pilar e viga. A migration 009 mantém o vínculo
em `piece_type_molds`, adiciona `placa` como tipo de peça e posição de bancada,
cria os registros de projeto/seções ligados a pedidos/itens, registra etapas de
produção com horários e guarda constantes por organização. Não cria catálogo
paralelo de formas nem altera as funções atuais de volume e peso. O peso da
placa usa X×Y como área, Z como espessura e a mesma densidade fixa de 2,5 t/m³
do cálculo atual de volume e peso das peças existentes.

Os prazos de preparação permanecem no campo existente `molds.preparation_days`;
a proposta fixa esse valor em cinco dias úteis e usa `calendar_days` para achar a
data de conclusão.

Como premissa de engenharia, uma seção maciça retangular de braço resulta em
218,75 kg/m para 25×35 cm, 325 kg/m para 25×52 cm e 450 kg/m para 30×60 cm,
usando 2,5 t/m³. O peso efetivo da peça continua dependendo do comprimento Z
cadastrado e da fórmula existente.

O planejador grava concretagem e cura em `production_order_steps` com horários
exatos, usa 120 minutos para concretagem e 12 horas para cura, e mantém a posição
reservada até o fim da cura. O horário padrão é 08:00 no fuso da organização
(`calculation_constants.casting_start_hour`); ajuste-o para o início real do
turno antes de aplicar a migration se a fábrica começar em outro horário.
Acabamento, inspeção e liberação aparecem como etapas pendentes enquanto suas
durações não forem definidas.

O cadastro de projeto chama `save_engineering_project_structure` para gravar o
projeto, as seções e a distribuição dos itens em uma transação. A RPC confere
que cada item pertence ao pedido escolhido e que a soma não ultrapassa a
quantidade pedida. Somente `service_role` pode executá-la.

As tabelas novas continuam com RLS ligado, sem policies para acesso anônimo;
somente as Edge Functions com `service_role` acessam os dados. Sem login, a
aplicação ainda depende da organização fixa configurada no servidor e não tem
isolamento multi-organização por usuário. As Edge Functions públicas continuam
sendo a fronteira de acesso e precisam validar organização e payload.

**A migration 009 e a integração da Etapa 5 estão no repositório/branch de
revisão. Não execute a migration nem publique as Edge Functions no projeto
Supabase ativo nesta etapa.** A
ferramenta Supabase CLI não está instalada neste ambiente, por isso o arquivo
segue a convenção `database/001–008` existente; ele não fica em
`supabase/migrations/` e não é executado automaticamente por `db push`.

A regra para rejeitar o status legado `concluido` não é validada contra linhas
históricas: pedidos já concluídos continuam preservados na base e precisam
receber um status vigente antes de serem editados.
