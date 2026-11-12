# Modelo PRELUX / Fábio II

O diagrama mantém os nomes das tabelas Supabase atuais (`mold_*` no banco; “forma” na interface). As tabelas de projeto, constantes e etapas são propostas da migration `009_fabio2_foundation.sql`, ainda não aplicada ao projeto Supabase ativo.

```mermaid
erDiagram
  ORGANIZATIONS ||--o{ CLIENTS : owns
  ORGANIZATIONS ||--o{ WORKS : owns
  ORGANIZATIONS ||--o{ ORDERS : owns
  ORGANIZATIONS ||--o{ PIECE_TYPES : owns
  ORGANIZATIONS ||--o{ MOLDS : owns
  ORGANIZATIONS ||--o{ MOLD_POSITIONS : owns
  ORGANIZATIONS ||--o{ STOCK_MOVEMENTS : owns
  ORGANIZATIONS ||--o{ STOCK_RESERVATIONS : owns
  ORGANIZATIONS ||--o{ RESOURCE_ALLOCATIONS : owns
  ORGANIZATIONS ||--o{ PRODUCTION_SCHEDULES : owns
  ORGANIZATIONS ||--o{ CALCULATION_CONSTANTS : configures
  ORGANIZATIONS ||--o{ ENGINEERING_PROJECTS : owns
  ORGANIZATIONS ||--o{ PRODUCTION_ORDER_STEPS : owns

  CLIENTS ||--o{ WORKS : client
  CLIENTS ||--o{ ORDERS : client
  WORKS o|--o{ ORDERS : source_of_client_and_start
  ORDERS ||--o{ ORDER_ITEMS : contains
  PIECE_TYPES ||--o{ ORDER_ITEMS : requested_type
  ORDERS ||--o{ STOCK_RESERVATIONS : reserves
  ORDER_ITEMS o|--o{ STOCK_RESERVATIONS : reserved_item
  PIECE_TYPES ||--o{ STOCK_RESERVATIONS : reserved_type
  PIECE_TYPES ||--o{ STOCK_MOVEMENTS : stock_type
  ORDERS ||--o{ PRODUCTION_SCHEDULES : legacy_summary
  ORDER_ITEMS ||--o{ PRODUCTION_SCHEDULES : legacy_item

  ORDERS ||--o| ENGINEERING_PROJECTS : has_one_project
  ENGINEERING_PROJECTS ||--o{ PROJECT_SECTIONS : groups
  PROJECT_SECTIONS ||--o{ PROJECT_SECTION_ITEMS : contains
  ORDER_ITEMS ||--o{ PROJECT_SECTION_ITEMS : distributes_quantity

  PIECE_TYPES ||--o{ PIECE_TYPE_MOLDS : selects
  MOLD_CATALOG ||--o{ PIECE_TYPE_MOLDS : catalog_measure
  MOLDS ||--o{ MOLD_PIECE_TYPES : compatible_asset
  PIECE_TYPES ||--o{ MOLD_PIECE_TYPES : compatible_type
  MOLD_CATALOG o|--o{ MOLDS : catalog_entry
  MOLDS ||--o{ MOLD_PREPARATIONS : prepared
  MOLDS o|--o{ RESOURCE_ALLOCATIONS : resource
  ORDER_ITEMS o|--o{ RESOURCE_ALLOCATIONS : resource_item

  MOLD_CATALOG o|--o{ MOLD_POSITIONS : arm_code
  MOLD_CATALOG o|--o{ MOLD_POSITIONS : bed_code
  MOLD_CATALOG o|--o{ MOLD_POSITIONS : side_code
  MOLD_POSITIONS ||--o{ MOLD_POSITION_CONFIGURATION_HISTORY : history
  ORDERS ||--o{ PRODUCTION_ORDERS : production
  ORDER_ITEMS ||--o{ PRODUCTION_ORDERS : produces_units
  PRODUCTION_ORDERS ||--o{ PRODUCTION_ORDER_STEPS : stages
  PRODUCTION_ORDERS ||--o{ ALLOCATIONS : scheduled_unit
  MOLD_POSITIONS ||--o{ ALLOCATIONS : assigned_position
```

## Cardinalidades e integridade

- Uma obra pode ter vários pedidos; um pedido pode não ter obra ou se vincular a uma. Quando há obra, trigger existente herda cliente e data de início. Sem obra, esses campos continuam manuais.
- Um pedido contém itens de catálogo (`order_items → piece_types`). O projeto de engenharia é opcional até a análise e, quando criado, há no máximo um por pedido. Ao salvar o projeto, as seções devem distribuir exatamente a quantidade pedida de cada item.
- `piece_types.piece_kind` preserva `braco`, `pilar` e `viga`; a migration 009 adiciona `placa`. Braço usa a forma fixa identificada pelas dimensões X × Z; pilar/viga usam LEITO para X, LATERAL para Z e Y como comprimento; placa não usa forma.
- `mold_catalog` continua sendo o catálogo global de medidas LEITO, LATERAL e BRAÇO. Seu `code` e `mold_type` são chaves estáveis; rótulo de medida e ordem de exibição podem ser editados, com bloqueio durante uso ativo e registro em `audit_logs`.
- `piece_type_molds` persiste a seleção compatível para um tipo de peça. `piece_mold_combinations` é uma view sem persistência: lista os braços fixos e o produto cartesiano de LEITO × LATERAL para pilar e viga.
- `mold_positions` representa os quatro espaços físicos P01–P04. Para braço, pilar e viga, a posição não fica presa a uma forma: o pedido determina os moldes e o planejador associa o item à posição livre. A exceção é a bancada plana, reservada para placa.
- `piece_type_molds` guarda os códigos de catálogo exigidos pelo item. A ligação `production_orders → order_items → piece_types → piece_type_molds → mold_catalog` permite consultar quais formas foram atribuídas a cada unidade e posição. A etapa atual não escolhe um exemplar físico individual por `molds.id`.
- `production_orders` representa uma unidade de um item. Seus horários exatos ficam em `production_order_steps`; `allocations` liga a unidade à posição, valida os moldes do item e protege a sobreposição de ocupação. A nova alocação reserva a posição desde a concretagem até o fim da cura de 12 horas. Linhas antigas sem horários representam o dia todo no fuso da unidade.
- `production_schedules` segue como resumo legado. A view `v_order_progress` deriva datas de planejamento de `production_orders`, sem gravar projeções em `orders`.

## Campos adicionados na proposta 009

`production_order_steps`: `id` (PK), `organization_id` (FK), `production_order_id` (FK composta), `step_kind`, `sequence`, `duration_minutes`, início/fim planejados e reais, status, observação e timestamps. Concretagem e cura têm tempos aprovados de 120 minutos e 12 horas. Durações de acabamento, inspeção e liberação ainda precisam ser fornecidas pela engenharia para calcular a liberação final.

`calculation_constants`: `id` (PK), `organization_id` (FK), `constant_key`, `numeric_value`, `unit`, `created_at`, `updated_at`; chave única por organização e histórico de alterações em `audit_logs`. Valores semeados: densidade do concreto 2,5 t/m³, início da concretagem às 08:00 no fuso da unidade, concretagem 120 min e cura 12 h. O horário inicial de 08:00 é um padrão editável porque o turno da fábrica não foi informado. Os cinco dias úteis de preparação usam o campo existente `molds.preparation_days`.

`engineering_projects`: `id` (PK), `organization_id` (FK), `order_id` (FK composta, único por organização), timestamps. `project_sections`: `id`, `organization_id`, `project_id` (FK composta), nome e ordem. `project_section_items`: `id`, `organization_id`, `section_id` e `order_item_id` (FKs compostas), quantidade e timestamps. A RPC `save_engineering_project_structure` recebe a divisão completa e grava projeto, seções e itens em uma única transação. Cada item do pedido deve ter a soma de suas quantidades nas seções exatamente igual à quantidade pedida; itens sem distribuição ou com distribuição excedente fazem a transação falhar. Para pedido já projetado, a RPC `save_order_with_project` atualiza pedido, itens e distribuição de seções no mesmo commit.

### Contrato do planejador para a integração da Etapa 3

Cada unidade enviada a `commit_order_plan` contém `steps[]` com `stepKind`, `sequence`, `durationMinutes`, `plannedStartAt` e `plannedEndAt`. `concretagem` e `cura` são obrigatórias e devem respeitar as constantes (120 e 720 minutos no valor inicial). Acabamento, inspeção e liberação aceitam tempo nulo até a engenharia definir as durações. O horário inicial vem de `casting_start_hour` (padrão editável 08:00) e do fuso da organização. A unidade também envia `occupiedFromAt` e `occupiedUntilAt`; o intervalo cobre concretagem e cura.

O cadastro de placa usa a nova RPC `save_plate_type(p_org_id, p_record)` com `code`, `name`, `dimensionXcm` (largura), `dimensionYcm` (altura), `dimensionZcm` (espessura), `productionMinutesPerUnit` e `observations`. O peso confirmado da placa é `largura × altura × espessura × 2,5 t/m³`; as três medidas participam do volume e do peso. A RPC `save_mold_position` mantém o status, as observações e a marca de bancada plana para placas. Para braço, pilar e viga, as formas BRAÇO, LEITO e LATERAL vêm do item do pedido e não ficam vinculadas permanentemente à posição.

## Exclusões, status e cálculos

- As relações pertencentes ao pedido/projeto usam cascata para que itens dependentes não sobrevivam ao pedido; vínculo de cliente em obra/pedido continua protegido por `RESTRICT`; `orders.work_id` continua `SET NULL`.
- O enum legado continua contendo `concluido`, mas o fluxo e novos valores usam apenas orçamento, aprovado, em produção, entregue, atrasado e cancelado. O `CHECK NOT VALID` preserva pedidos históricos concluídos; um pedido legado precisa receber um status vigente para ser editado. Para bloqueios de catálogo, esses pedidos históricos são tratados como encerrados.
- A preparação de forma é calculada com cinco datas úteis inclusivas a partir de `calendar_days`. É necessário gerar o calendário antes de programar a preparação.
- Para braço, pilar e viga, a migration não altera as funções atuais de volume e peso: volume segue X×Y×Z e densidade fixa de 2,5 t/m³. A constante de densidade fica registrada, mas editar esse registro não muda o cálculo legado. Para placa, o peso confirmado é X×Y×Z com densidade fixa de 2,5 t/m³; X×Y é a área e Z é a espessura.
- Concretagem e cura têm duração definida; acabamento, inspeção e liberação podem permanecer sem duração enquanto a engenharia não fornecer os tempos. Sem esses valores, o sistema não consegue apresentar uma previsão final de liberação.
- Como estimativa de engenharia, a seção retangular fixa de braço representa 218,75 kg/m (25×35 cm), 325 kg/m (25×52 cm) e 450 kg/m (30×60 cm). São contas geométricas usando 2,5 t/m³; confirme a hipótese de seção maciça com a engenharia.

## RLS

As tabelas operacionais e as novas tabelas mantêm RLS ligado sem policies públicas; somente `service_role` tem acesso direto via Edge Functions. Como o site segue sem login, isso não isola usuários ou organizações no endpoint público. O backend precisa manter a organização fixa da PRELUX e validar cada `organization_id`; isolamento multi-organização por usuário depende de autenticação futura.

> O esquema acima descreve a migration 009 em revisão. Não foi aplicado ao Supabase ativo.
