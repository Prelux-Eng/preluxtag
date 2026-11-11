# PRELUX — Pedidos, Planejamento e Etiquetas

Aplicação PWA da PRELUX para conduzir pedidos, planejamento e etiquetas de produção. A primeira etapa funciona sem login. O front-end é servido como site estático; os dados e as operações de produção usam Supabase (PostgreSQL e Edge Functions).

Site publicado: [prelux-emissor-etiquetas.openbat65.chatgpt.site](https://prelux-emissor-etiquetas.openbat65.chatgpt.site/).

## Estrutura

- `dist/` — aplicação web estática publicada pelo Site. O navegador usa módulos ES sem framework ou etapa de compilação.
- `database/` — scripts SQL incrementais e diagrama do schema.
- `supabase/functions/` — Edge Functions e módulos compartilhados do backend.
- `backend/` — configuração e documentação operacional do Supabase.
- `tests/` — testes existentes do planejador puro.
- `package.json` — comandos Node.js do projeto.
- `docs/ARCHITECTURE.md` — mapa da arquitetura, responsabilidades e fluxo dos dados.

O código do navegador começa em `dist/js/main.js`. A navegação tem três áreas: **PEDIDOS**, **PLANEJAMENTO** e **ETIQUETAS**. A área PEDIDOS contém o fluxo **Pedido → Engenharia → Projeto → Produzir** e o subtópico **Cadastro** (obras, peças, formas e posições). Para entender a estrutura e o caminho entre navegador, Edge Functions e banco, consulte [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Este repositório contém código e scripts de schema; não contém exportação de registros de produção. Os arquivos de ambiente reais, chaves e credenciais não devem ser versionados.

## Desenvolvimento local

O projeto não exige dependências npm para os arquivos estáticos. Node.js é usado pelo comando de teste já existente:

```bash
npm test
```

Para visualizar o PWA localmente, não abra `dist/index.html` diretamente. Os módulos ES e o service worker precisam de HTTP. Na raiz do repositório, execute:

```bash
npm start
```

Se o comando `npm` não estiver disponível, execute `node scripts/serve.mjs`. Depois, acesse `http://127.0.0.1:4173`. O servidor usa apenas Node.js e arquivos da pasta `dist/`; não instala dependências. A configuração do backend e a chave pública do cliente continuam dependentes do ambiente Supabase associado.

## Supabase

Consulte [`database/README.md`](database/README.md) para a ordem das migrações e [`backend/README.md`](backend/README.md) para publicação das Edge Functions.
Para decisões e pendências da Etapa 5, consulte [`docs/FABIO_II_ETAPA5_REVISAO.md`](docs/FABIO_II_ETAPA5_REVISAO.md).

- Em uma instalação nova, aplique os scripts `database/001` a `database/008` na ordem descrita.
- O projeto Supabase em uso já contém o schema da etapa 8. Não reaplique migrações anteriores sobre ele.
- A etapa 8 herda cliente e data da obra para pedidos vinculados, e disponibiliza as combinações de molde: BRAÇO fixo; LEITO × LATERAL para Pilar e Viga.
- Volume e peso seguem calculados pela lógica existente no site.
- A migration `database/009_fabio2_foundation.sql` permanece como rascunho local da Etapa 5; ela não deve ser considerada aplicada ao Supabase ativo.

A `SUPABASE_SERVICE_ROLE_KEY` pertence somente ao ambiente das Edge Functions. Nunca a coloque no front-end, em um arquivo `.env` versionado, no GitHub ou em aplicativos distribuídos.

## Publicação

O site estático é publicado pelo Sites. As Edge Functions e o schema são administrados pelo Supabase. Mantenha as duas publicações coordenadas ao alterar interfaces ou contratos do backend.

