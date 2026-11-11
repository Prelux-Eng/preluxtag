# Contribuindo

1. Faça alterações focadas e preserve as tabelas, cálculos e fluxos existentes.
2. Antes de alterar o banco, confira o schema atual no Supabase e prefira migrações incrementais.
3. Registre mudanças de banco em `database/` e atualize `database/ER.md` e `database/README.md` quando relações ou regras mudarem.
4. Mantenha `SUPABASE_SERVICE_ROLE_KEY` somente no ambiente do servidor. Nunca inclua chaves reais, arquivos `.env`, dados de produção ou pacotes de publicação no commit.
5. Ao mudar arquivos estáticos, confira o cache busting do service worker em `dist/sw.js` e as referências de assets em `dist/index.html`.
6. Inicie a aplicação em `dist/js/main.js`. Mantenha a interface em `features/`, o transporte em `core/api.js`, as chamadas ao backend em `repositories/` e as regras puras em `domain/`.
7. Passe repositórios e navegação como dependências das áreas. Use eventos de janela apenas para avisos entre áreas e deixe a configuração pública em `PRELUX_CONFIG`.
8. O front-end continua estático e sem compilação. Ao adicionar um módulo, inclua-o no shell de `dist/sw.js` e confirme que a versão do cache foi avançada.

O comando de teste existente é `npm test`; ele cobre o planejador isolado. A reorganização do front-end não instala dependências nem altera o schema do Supabase.

