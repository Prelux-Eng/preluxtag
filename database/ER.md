# Diagrama ER — PRELUX

```mermaid
erDiagram
  ORGANIZATIONS ||--|| CALENDAR_SETTINGS : configura
  ORGANIZATIONS ||--o{ CALENDAR_EXCEPTIONS : cadastra
  ORGANIZATIONS ||--o{ CALENDAR_DAYS : gera
  ORGANIZATIONS ||--o{ PIECE_TYPES : possui
  ORGANIZATIONS ||--o{ WORKS : organiza
  PIECE_TYPES ||--o{ ORDER_ITEMS : compoe
  ORGANIZATIONS ||--o{ CLIENTS : cadastra
  CLIENTS ||--o{ ORDERS : recebe
  CLIENTS ||--o{ WORKS : atende
  WORKS ||--o{ ORDERS : agrupa
  ORDERS ||--|{ ORDER_ITEMS : contem
  ORDER_ITEMS ||--o{ PRODUCTION_SCHEDULES : agenda
  ORGANIZATIONS ||--o{ MOLDS : possui
  MOLDS ||--o{ MOLD_PIECE_TYPES : aceita
  PIECE_TYPES ||--o{ MOLD_PIECE_TYPES : compativel
  MOLDS ||--o{ MOLD_PREPARATIONS : prepara
  MOLDS ||--o{ RESOURCE_ALLOCATIONS : ocupa
  ORDER_ITEMS ||--o{ RESOURCE_ALLOCATIONS : produz
  PIECE_TYPES ||--o{ STOCK_MOVEMENTS : movimenta
  ORDERS ||--o{ STOCK_RESERVATIONS : reserva
```

As tabelas `v_piece_inventory`, `v_capacity_daily` e `v_order_progress` são visões de leitura para estoque, ocupação e acompanhamento dos pedidos.

`mold_preparations` registra o checklist e a aprovação de sete dias corridos. `resource_allocations` liga o recurso ao item do pedido e impede sobreposição do mesmo molde; sobreposições em outros recursos exigem justificativa e responsável.
