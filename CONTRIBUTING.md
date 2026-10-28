# Contribuindo

1. Faça alterações focadas e preserve as tabelas, cálculos e fluxos existentes.
2. Antes de alterar o banco, confira o schema atual no Supabase e prefira migrações incrementais.
3. Registre mudanças de banco em `database/` e atualize `database/ER.md` e `database/README.md` quando relações ou regras mudarem.
4. Mantenha `SUPABASE_SERVICE_ROLE_KEY` somente no ambiente do servidor. Nunca inclua chaves reais, arquivos `.env`, dados de produção ou pacotes de publicação no commit.
5. Ao mudar arquivos estáticos, confira o cache busting do service worker em `dist/sw.js` e as referências de assets em `dist/index.html`.

O comando de teste existente é `npm test`; ele cobre o planejador isolado.

