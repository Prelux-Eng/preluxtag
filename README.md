# PRELUX — Pedidos, Planejamento e Etiquetas

Aplicação PWA da PRELUX para conduzir pedidos, planejamento e etiquetas de produção. A primeira etapa funciona sem login. O front-end é servido como site estático; os dados e as operações de produção usam Supabase (PostgreSQL e Edge Functions).

Site publicado: [PRELUX Etiquetas](https://prelux-emissor-etiquetas.glaubertmiranda15.chatgpt.site/).

## Estrutura

- `dist/` — aplicação web estática publicada pelo Site. O navegador usa módulos ES sem framework ou etapa de compilação.
- `database/` — scripts SQL incrementais e diagrama do schema.
- `supabase/functions/` — Edge Functions e módulos compartilhados do backend.
- `backend/` — configuração e documentação operacional do Supabase.
- `tests/` — testes existentes do planejador puro.
- `package.json` — comandos Node.js do projeto.
- `docs/ARCHITECTURE.md` — mapa da arquitetura, responsabilidades e fluxo dos dados.

O código do navegador começa em `dist/js/main.js`. A navegação tem duas áreas: **PEDIDOS** e **PLANEJAMENTO**. PEDIDOS contém **Pedido → Engenharia → Projeto → Produzir → Etiquetas** e o subtópico **Cadastro** (obras, peças, formas e posições). Ao concluir todas as unidades do pedido, o banco gera uma etiqueta para cada peça. O editor de etiquetas avulsas continua disponível dentro de Pedidos, com histórico local. Para entender o caminho entre navegador, Edge Functions e banco, consulte [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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
O fluxo de simulação e confirmação da fila está em [`docs/ETAPA5_CONFIRMACAO_PLANO.md`](docs/ETAPA5_CONFIRMACAO_PLANO.md).
O motor de simulação da Etapa 2 e sua API somente de leitura estão documentados em [`docs/ETAPA2_MOTOR_SIMULACAO.md`](docs/ETAPA2_MOTOR_SIMULACAO.md).
O calendário de previsão da Etapa 3 está documentado em [`docs/ETAPA3_CALENDARIO.md`](docs/ETAPA3_CALENDARIO.md).

- Em uma instalação nova, aplique os scripts `database/001` a `database/014` na ordem descrita.
- O projeto Supabase em uso contém a estrutura até a migration 021. As posições são espaços físicos que recebem os moldes exigidos por cada pedido.
- Pedidos com obra herdam cliente e início; sem obra, os dados são informados no pedido. BRAÇO usa X × Z; Pilar e Viga usam LEITO para X e LATERAL para Z, com Y como comprimento.
- Volume e peso seguem calculados pela lógica existente no site.
- As migrations `database/009_fabio2_foundation.sql` a `database/014_order_approval_timestamp.sql` fazem parte do schema ativo do Supabase.

A `SUPABASE_SERVICE_ROLE_KEY` pertence somente ao ambiente das Edge Functions. Nunca a coloque no front-end, em um arquivo `.env` versionado, no GitHub ou em aplicativos distribuídos.

## Publicação

O site estático é publicado pelo Sites. As Edge Functions e o schema são administrados pelo Supabase. Mantenha as duas publicações coordenadas ao alterar interfaces ou contratos do backend.

