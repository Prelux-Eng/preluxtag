# Etapa 5 — confirmação transacional do Planejamento

## Fluxo do operador

1. O servidor lê pedidos aprovados e, se selecionados, orçamentos; combina os
   dados com itens, tipos de peça, formas, posições e calendário.
2. O simulador organiza a fila. Um molde já pronto pode ser reutilizado. Uma
   troca de configuração reserva a posição por cinco dias úteis antes da
   concretagem. O início físico nunca é programado antes do dia atual da
   unidade; a data original do pedido continua sendo usada para o prazo.
3. O cenário mostra quantas unidades cabem e quais aguardam posição. Orçamento
   continua sem reserva enquanto for apenas simulação.
4. Ao confirmar, o servidor recalcula o cenário. A RPC compara a revisão dos
   dados e grava o resultado em uma transação; se qualquer fonte mudou, o banco
   rejeita e a pessoa precisa atualizar a simulação.
5. Os orçamentos marcados tornam-se aprovados dentro da mesma transação que
   grava a fila. A capacidade não disponível não bloqueia as unidades que
   couberam; as restantes ficam aguardando uma nova capacidade.

## Etapas e posição física

| Etapa | Duração usada | Ocupa P01–P04? |
| --- | --- | --- |
| Preparação de forma | Cinco dias úteis quando a configuração muda | Sim |
| Concretagem | Capacidade do turno no calendário | Sim |
| Cura | Dois dias corridos | Não |
| Acabamento | Um turno no primeiro dia útil após a cura | Não |

O horário inicial do turno vem de `calculation_constants.casting_start_hour`;
os minutos do turno vêm de `calendar_days.capacity_minutes`. As etapas recebem
timestamps com o fuso horário da organização.

## Proteção do histórico

A confirmação remove apenas reservas e ordens de produção que ainda estejam
`planned` para pedidos sem execução iniciada. Registros de produção iniciados,
concluídos ou refugados, suas etapas e alocações são preservados e considerados
como ocupação fixa na simulação. A migration não limpa cadastros nem histórico.
Datas de pedidos entregues ou cancelados não são zeradas ao reconstruir a fila.

`allocations.mold_catalog_codes` guarda os códigos da forma usados em cada
unidade. O servidor lê a última concretagem concluída por posição e considera
essa forma montada nos próximos ciclos. Alocações canceladas são excluídas.
O operador pode usar **Desmontar forma** quando não houver unidade reservada;
a troca de tipo da posição também encerra esse estado.

## Contrato técnico

- `factory_plan_revisions` é uma tabela auxiliar com RLS habilitado e sem acesso
  público; o servidor pode ler a revisão.
- Triggers incrementam a revisão uma vez por organização e transação nas tabelas
  que alteram o cenário e nas tabelas de destino.
- `commit_factory_simulation` é `SECURITY DEFINER`, usa `search_path` vazio e
  tem execução revogada de `PUBLIC`, `anon` e `authenticated`; somente
  `service_role` pode chamá-la.
- A Edge Function `confirm-production-plan` não aceita horários da interface;
  ela recalcula e constrói o payload a partir do estado atual do Supabase.
- A antiga Edge Function `commit-order-plan` retorna HTTP 410 e não grava dados.
- Unidades planejadas não iniciadas podem ser substituídas. Unidades em execução
  e concluídas ficam protegidas.

## Verificação após implantação

Migrations `20261112184304`, `20261113115042` e `20261113123225` aplicadas.
RPC e triggers estão presentes; a confirmação só aceita `service_role` e a
revisão tem RLS sem políticas públicas. As 15 ordens/alocações planejadas
continuam preservadas. Edge Functions ativas: `simulate-production` v6,
`confirm-production-plan` v4, `operations-admin` v15 e rota legada
`commit-order-plan` v6. Site público na versão 35, baseado no commit Sites
`e1d43c5aeb2de6f7493a101d8577449094ee7536`.
