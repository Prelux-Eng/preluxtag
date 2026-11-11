# Proposta SQL — cadastro integrado de pedido e peça

> **Aprovado para integração local; migration ainda não aplicada ao Supabase ativo.**

## Estado atual

- O Supabase ativo está na migration 008; `database/009_fabio2_foundation.sql` foi atualizada localmente com esta proposta e ainda não foi aplicada ao projeto ativo.
- A migration 009 já cria `calculation_constants`, `piece_mold_combinations`, as etapas do projeto e `commit_planning_queue`.
- `piece_types.custom_fields` já existe. A proposta guarda `geometryParts` nesse JSON, sem criar uma tabela ou coluna paralela.
- `allocations_one_active_position_day_idx` já impede duas unidades planejadas para a mesma posição e dia. A nova RPC reutiliza `production_orders`, `allocations` e `commit_planning_queue`.

## Alterações integradas ao rascunho local da 009

1. Criar índice único parcial em `orders(organization_id, upper(order_number))`, somente para números no formato PED-<número>, preservando os números legados. A migration aborta se encontrar PED duplicado por organização:

   ```sql
   select organization_id, upper(order_number) as order_number, count(*)
   from public.orders
   where order_number ~* '^PED-[0-9]+$'
   group by organization_id, upper(order_number)
   having count(*) > 1;
   ```

2. Adicionar `public.create_order_piece_registration(uuid, jsonb) returns jsonb` com `SECURITY DEFINER`, `search_path = public, pg_temp`, execução revogada de `public`, `anon` e `authenticated`, e concedida somente a `service_role`.

3. A RPC executa, na mesma transação:

   - bloqueio transacional por organização para gerar `PED-0001`, `PED-0002` etc. sem corrida;
   - busca ou criação do cliente pelo nome;
   - atualização da obra existente pelo número, ou criação quando não existir;
   - criação do tipo de peça com o UUID previsto pelo planejador, dimensões, volume/peso recalculados na RPC e composição em `custom_fields.geometryParts`;
   - gravação das compatibilidades de catálogo em `piece_type_molds` (braço fixo para braço; leito e lateral para pilar/viga);
   - criação do pedido e do item com os UUIDs usados pelo plano, prazo de 90 dias, quantidade e snapshot de minutos por unidade;
   - upsert dos dias de concretagem informados em `planningCalendarDays`;
   - chamada a `commit_planning_queue` quando houver planos a confirmar;
   - retorno de número do pedido, IDs criados e posições atribuídas.

A Edge Function calcula as métricas para a prévia e para o planejador. A RPC valida as dimensões e recalcula volume e peso no banco antes de gravar, junto com a composição geométrica, para não confiar em valores derivados enviados pelo navegador.

## Comportamento sem posição compatível

O Edge não inclui o pedido novo na lista de planos quando a simulação não encontra posição compatível livre. A RPC ainda cria obra, pedido, item, peça e compatibilidade, mas não cria produção/alocação para essa peça. A tela deriva “Aguardando posição” quando a quantidade do item excede as unidades planejadas. O próximo replanejamento pode alocá-la quando uma posição compatível ficar livre.

## Tempos por tipo

Salvar em `calculation_constants`, por organização, usando as chaves `production_minutes_braco`, `production_minutes_pilar` e `production_minutes_viga`, unidade `min/un`. Nenhum tempo padrão será inserido. A capacidade diária permanece em `calendar_settings`.

## Garantias de segurança e integridade

- O navegador chama apenas `operations-admin`; não recebe acesso direto às tabelas nem à chave `service_role`.
- Cliente, obra, peça, pedido, item, compatibilidades, dias de concretagem e alocações ficam na mesma transação da RPC.
- A trigger de herança da migration 008 continua definindo cliente e data de início do pedido a partir da obra.
- O prazo gravado no pedido e na obra é calculado no Edge Function; alteração manual é preservada e validada contra a data de início.
- Não se adiciona status novo para fila: o pedido mantém `orcamento`, e “Aguardando posição” é informação derivada das unidades ainda não planejadas.
