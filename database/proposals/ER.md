# PRELUX · diagrama ER proposto (Etapa 1)

Este diagrama descreve a proposta isolada em `stage1_schema.sql`. Ele não altera
o banco `public` atual. O tempo de setup permanece sem valor até ser informado.

```mermaid
erDiagram
  ORGANIZATIONS ||--|| CALENDAR_SETTINGS : configura
  ORGANIZATIONS ||--o{ CALENDAR_DAYS : gera
  ORGANIZATIONS ||--o{ CALENDAR_EXCEPTIONS : cadastra
  ORGANIZATIONS ||--o{ CLIENTS : cadastra
  CLIENTS ||--o{ WORKS : contrata
  CLIENTS ||--o{ ORDERS : solicita
  WORKS o|--o{ ORDERS : agrupa
  ORDERS ||--|{ ORDER_ITEMS : contem
  PIECE_TYPES ||--o{ PIECES : classifica
  PIECES ||--|{ PIECE_MOLDS : exige
  MOLD_CATALOG ||--o{ PIECE_MOLDS : selecionado
  ORGANIZATIONS ||--o{ MOLD_POSITIONS : possui
  MOLD_POSITIONS ||--o{ MOLD_POSITION_MOLDS : configura
  MOLD_CATALOG ||--o{ MOLD_POSITION_MOLDS : instalado
  MOLD_POSITIONS ||--o{ MOLD_PREPARATIONS : prepara
  PIECES ||--o{ ORDER_ITEMS : solicitado
  ORDER_ITEMS ||--|{ PRODUCTION_ORDERS : desdobra
  ORDERS ||--o{ PRODUCTION_ORDERS : programa
  PRODUCTION_BATCHES o|--o{ PRODUCTION_ORDERS : rastreia
  PRODUCTION_ORDERS ||--o{ ALLOCATIONS : aloca
  MOLD_POSITIONS ||--o{ ALLOCATIONS : ocupa
  PRODUCTION_ORDERS ||--o{ CURING_RECORDS : cura
  QUALITY_REQUIREMENTS o|--o{ CURING_RECORDS : criterio_opcional
  PRODUCTION_BATCHES ||--o{ INSPECTIONS : inspeciona
  PRODUCTION_ORDERS o|--o{ INSPECTIONS : identifica
  PRODUCTION_ORDERS ||--o{ REWORK_ORDERS : retrabalha
  INSPECTIONS o|--o{ REWORK_ORDERS : origina
  PRODUCTION_ORDERS ||--o{ SCRAP_RECORDS : refugado
  PRODUCTION_BATCHES o|--o{ SCRAP_RECORDS : lote
  PIECES ||--o{ BOM_ITEMS : consome
  MATERIALS ||--o{ BOM_ITEMS : componente
  ORDER_ITEMS ||--o{ MATERIAL_RESERVATIONS : reserva
  BOM_ITEMS ||--o{ MATERIAL_RESERVATIONS : calcula
  MATERIALS ||--o{ MATERIAL_MOVEMENTS : movimenta
  ORDERS o|--o{ MATERIAL_MOVEMENTS : referencia
  PRODUCTION_ORDERS o|--o{ MATERIAL_MOVEMENTS : baixa
  YARD_LOCATIONS o|--o{ CURING_RECORDS : localiza
  YARD_LOCATIONS o|--o{ FINISHED_GOODS_INVENTORY : armazena
  PRODUCTION_ORDERS ||--o| FINISHED_GOODS_INVENTORY : vira_estoque
  ORDERS o|--o{ FINISHED_GOODS_INVENTORY : reserva_para
  PRODUCTION_ORDERS ||--o{ FINISHED_GOODS_MOVEMENTS : movimenta
  YARD_LOCATIONS o|--o{ FINISHED_GOODS_MOVEMENTS : origem_destino
  ORDERS ||--o{ SHIPMENTS : expede
  SHIPMENTS ||--|{ SHIPMENT_ITEMS : contem
  PRODUCTION_ORDERS ||--o{ SHIPMENT_ITEMS : embarca
  SHIPMENTS ||--o{ ASSEMBLY_RECORDS : monta
  WORKS ||--o{ ASSEMBLY_RECORDS : recebe
  ORDERS ||--o{ DELAY_ADJUSTMENTS : ajusta_prazo
  PRODUCTION_ORDERS o|--o{ DELAY_ADJUSTMENTS : impacto_unidade
  ORGANIZATIONS ||--o{ KPI_SNAPSHOTS : consolida
  ORGANIZATIONS ||--o{ AUDIT_LOGS : audita
```

## Notas de cardinalidade e unidades

- `production_orders` representa uma unidade física. A quantidade do item do
  pedido é desdobrada em N unidades para formar a fila de concretagem e manter
  rastreabilidade individual.
- Uma `allocation` ocupa uma posição de molde em uma data de concretagem. A
  desocupação ocorre após a concretagem; a cura não retém a posição.
- A capacidade do calendário considera somente as quatro posições de molde.
  Central de concreto, equipe e içamento não limitam a programação nesta fase.
- Em Pilar/Viga, LEITO e LATERAL compõem a configuração de uma mesma posição.
  A preparação permanece em sete dias corridos, conforme confirmação do usuário.
  O tempo de setup segue sem duração numérica e não desloca datas até ser definido.
- Uma data inicial não útil é avançada para o próximo dia útil.
- `piece_molds` registra o molde ou conjunto de moldes requerido pela peça.
  A validação de combinação (Braço = BRAÇO; Pilar/Viga = LEITO + LATERAL) fica
  na transação da API e em constraint/trigger no schema público final.
- `production_orders.quality_status` suporta os estados da ficha de
  rastreabilidade consultada: liberada, em reparo e bloqueada.
- `curing_records` guarda os dias de cura usados naquela unidade e a evidência
  de liberação. A resistência mínima não bloqueia a desforma nesta fase; os
  campos ficam opcionais para uso futuro.
- Estoque de materiais e peças prontas é registrado por movimentos e reservas.
  Falta real de material pode impedir a liberação para produção, mas não altera
  o prazo linear. Reprocessos e atrasos são registrados como ajustes manuais.
- A resistência mínima para desforma não bloqueia o fluxo nesta fase, conforme
  orientação do usuário; os campos técnicos permanecem opcionais.
