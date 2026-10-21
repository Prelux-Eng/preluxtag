# Banco da Etapa 2

O banco foi desenhado para uma única unidade produtiva PRELUX, com capacidade em minutos.

## Aplicação no Supabase

Execute os arquivos na ordem abaixo pelo SQL Editor ou pela CLI do Supabase:

1. `001_initial_schema.sql`
2. `002_stage2_functions.sql`

O script cria a organização inicial com o ID:

`11111111-1111-4111-8111-111111111111`

Esse valor deve ser configurado como `PRELUX_ORGANIZATION_ID` nas Edge Functions. O `SUPABASE_SERVICE_ROLE_KEY` deve ficar apenas no ambiente do Supabase; nunca deve ser colocado no HTML, no PWA ou no aplicativo mobile.

As tabelas estão protegidas por RLS sem policies públicas. Portanto, o navegador não fala diretamente com o banco: ele chama as Edge Functions, que validam o payload e usam a chave administrativa somente no servidor.
