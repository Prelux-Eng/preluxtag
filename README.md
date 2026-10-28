# PRELUX — Emissor de Etiquetas

Aplicação PWA para emissão de etiquetas e apoio ao planejamento operacional da PRELUX. O front-end é servido como site estático; os dados e as operações de produção usam Supabase (PostgreSQL e Edge Functions).

Site publicado: [prelux-emissor-etiquetas.openbat65.chatgpt.site](https://prelux-emissor-etiquetas.openbat65.chatgpt.site/).

## Estrutura

- `dist/` — aplicação web estática publicada pelo Site.
- `database/` — scripts SQL incrementais e diagrama do schema.
- `supabase/functions/` — Edge Functions e módulos compartilhados do backend.
- `backend/` — configuração e documentação operacional do Supabase.
- `tests/` — testes existentes do planejador puro.
- `package.json` — comandos Node.js do projeto.

Este repositório contém código e scripts de schema; não contém exportação de registros de produção. Os arquivos de ambiente reais, chaves e credenciais não devem ser versionados.

## Desenvolvimento local

O projeto não exige dependências npm para os arquivos estáticos. Node.js é usado pelo comando de teste já existente:

```bash
npm test
```

Para visualizar o PWA localmente, sirva a pasta `dist/` por um servidor HTTP estático. A configuração do backend e as chaves públicas do cliente dependem do ambiente Supabase associado.

## Supabase

Consulte [`database/README.md`](database/README.md) para a ordem das migrações e [`backend/README.md`](backend/README.md) para publicação das Edge Functions.

- Em uma instalação nova, aplique os scripts `database/001` a `database/008` na ordem descrita.
- O projeto Supabase em uso já contém o schema da etapa 8. Não reaplique migrações anteriores sobre ele.
- A etapa 8 herda cliente e data da obra para pedidos vinculados, e disponibiliza as combinações de molde: BRAÇO fixo; LEITO × LATERAL para Pilar e Viga.
- Volume e peso seguem calculados pela lógica existente no site.

A `SUPABASE_SERVICE_ROLE_KEY` pertence somente ao ambiente das Edge Functions. Nunca a coloque no front-end, em um arquivo `.env` versionado, no GitHub ou em aplicativos distribuídos.

## Publicação

O site estático é publicado pelo Sites. As Edge Functions e o schema são administrados pelo Supabase. Mantenha as duas publicações coordenadas ao alterar interfaces ou contratos do backend.

