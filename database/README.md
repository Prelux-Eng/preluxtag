# Banco PRELUX · planejamento e cadastros operacionais

O banco foi desenhado para uma única unidade produtiva PRELUX, com capacidade em minutos.

## Aplicação no Supabase

Execute os arquivos na ordem abaixo pelo SQL Editor ou pela CLI do Supabase:

1. `001_initial_schema.sql`
2. `002_stage2_functions.sql`
3. `003_persist_replanned_dates.sql`
4. `004_works_pieces_molds.sql`
5. `005_optional_mold_cycle.sql`

Se as migrações 001–004 já estiverem aplicadas, execute apenas `005_optional_mold_cycle.sql`. Ela permite cadastrar moldes sem informar o ciclo enquanto esse dado não estiver definido.

O script cria a organização inicial com o ID:

`11111111-1111-4111-8111-111111111111`

Esse valor deve ser configurado como `PRELUX_ORGANIZATION_ID` nas Edge Functions. O `SUPABASE_SERVICE_ROLE_KEY` deve ficar apenas no ambiente do Supabase; nunca deve ser colocado no HTML, no PWA ou no aplicativo mobile.

As tabelas estão protegidas por RLS sem policies públicas. Portanto, o navegador não fala diretamente com o banco: ele chama as Edge Functions, que validam o payload e usam a chave administrativa somente no servidor.

Regras da migração 004: a preparação do molde dura sete dias corridos e só pode ser aprovada após limpeza, desmoldante e montagem; uma produção exige preparação aprovada e compatibilidade entre molde e tipo de peça. Reservas de um mesmo molde não podem se sobrepor. Para conflitos em outro recurso, a alocação deve registrar justificativa e responsável.

O cadastro de tipo de peça não utiliza os campos de cura e armadura. O tempo de produção por unidade permanece no catálogo para o planejamento.
