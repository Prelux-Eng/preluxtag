# Etapa 5 — etiquetas de produção

## Decisão de fluxo

O pedido continua recebendo o status **Concluído** quando todas as unidades
solicitadas ficam **Prontas**. Nesse momento, a trigger já existente no banco
gera automaticamente uma etiqueta para cada unidade. A caixa **LIBERADA** do
modelo continua vazia para conferência manual. A etiqueta de produção não é
gerada na aprovação do pedido.

## Dados e versões

- `production_labels` continua sendo o retrato atual usado pela tela e pelos
  arquivos de etiqueta. Cada registro também informa `version_number`.
- `production_label_versions` guarda os retratos históricos. As etiquetas já
  existentes são preservadas como versão 1 pela migration 027.
- A função `ensure_order_labels` mantém a geração idempotente. Se a unidade não
  tem etiqueta, cria a versão 1. Se ela já existe e o conteúdo está igual, não
  altera a versão. Se o conteúdo do retrato mudou numa nova chamada, grava a
  próxima versão e atualiza o retrato corrente.
- A tela exibe a versão corrente. A prévia não cria um evento de impressão.

## Emissão e reimpressão

Os arquivos PNG, ZIP e o diálogo de impressão das etiquetas de produção pedem
o nome do responsável antes de liberar a emissão. A Edge Function encaminha a
solicitação à RPC `record_production_label_prints`, que valida se cada versão
é a corrente de uma unidade pronta de um pedido concluído e grava um evento
por unidade em `production_label_print_events`.

A chave de idempotência é mantida na sessão do navegador enquanto a mesma
solicitação estiver pendente. Repetir a mesma requisição não duplica eventos;
uma nova emissão intencional usa uma nova chave. O registro contém o horário
da solicitação e o nome informado pelo operador. Como não há login, o nome é
autodeclarado e não prova a identidade da pessoa. O navegador também não
consegue comprovar que a impressora física concluiu o trabalho; por isso o
evento representa uma solicitação de emissão.

Etiquetas avulsas continuam no fluxo local existente e não são registradas no
histórico de produção do banco.

Quando o pedido for removido pela rotina de exclusão com auditoria, os
retratos de versão e os eventos de emissão são copiados para o histórico do
pedido antes da exclusão em cascata das unidades.

## Segurança e publicação

As três tabelas de etiqueta mantêm RLS ativa e sem permissões diretas para
`anon` ou `authenticated`. A leitura e a gravação são feitas pela Edge
Function com `service_role`; as funções SQL novas são executáveis somente por
esse papel.

As migrations 027–029 já foram aplicadas ao Supabase ativo; o conjunto atual
não tinha etiquetas anteriores para copiar. As Edge Functions
`operations-admin`, `confirm-production-plan`, `simulate-production` e
`engineering-admin` também foram publicadas. A interface da Etapa 5 foi
publicada no Site público PRELUX em 17/11/2026.
