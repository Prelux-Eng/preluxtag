# Como o PRELUX está organizado

Este documento explica o caminho dos dados e a responsabilidade de cada arquivo principal. A aplicação é um **monólito modular**: existe uma única experiência publicada, separada em módulos por área.

## Visão geral

```mermaid
flowchart LR
  UI[Interface em dist/index.html]
  NAV[core/navigation.js]
  LABEL[modules/label-emitter.js]
  PLAN[modules/production-calendar.js]
  OPS[modules/operations-admin.js]
  DOMAIN[domain/mold-compatibility.js]
  PREPO[repositories/planning-repository.js]
  OREPO[repositories/operations-repository.js]
  API[core/api.js]
  EDGE[Supabase Edge Functions]
  SHARED[functions/_shared]
  DB[(Supabase PostgreSQL)]
  LOCAL[(localStorage do navegador)]

  UI --> NAV
  UI --> LABEL
  UI --> PLAN
  UI --> OPS
  OPS --> DOMAIN
  PLAN --> PREPO
  OPS --> OREPO
  PREPO --> API
  OREPO --> API
  API --> EDGE
  EDGE --> SHARED
  SHARED --> DB
  LABEL --> LOCAL
```

## Arquivos do navegador

| Arquivo | Responsabilidade |
| --- | --- |
| `dist/index.html` | Define as três abas e os elementos da página. Também fornece a configuração pública do Supabase antes de carregar os módulos. |
| `dist/css/app.css` | Estilos gerais, da etiqueta e do calendário. |
| `dist/css/operations.css` | Estilos adicionais dos cadastros e operações. |
| `dist/js/core/navigation.js` | Único lugar que alterna Etiquetas, Planejamento e Cadastros. Atualiza título, acessibilidade e envia eventos para a aba aberta. |
| `dist/js/core/api.js` | Transporte HTTP comum para as Edge Functions e conversão de respostas inválidas em `PreluxApiError`. |
| `dist/js/domain/mold-compatibility.js` | Estratégias puras de escolha de moldes: braço usa o catálogo fixo BRACO; pilar e viga usam LEITO × LATERAL. Inclui fallback local para a view do banco. |
| `dist/js/repositories/planning-repository.js` | Endpoints de calendário, planejamento e simulação/confirmação dos pedidos. |
| `dist/js/repositories/operations-repository.js` | Endpoints de leitura e gravação de obras, pedidos, peças, moldes, posições e alocações. |
| `dist/js/modules/label-emitter.js` | Desenha etiquetas, salva o histórico no navegador, exporta PNG/ZIP e prepara a impressão. |
| `dist/js/modules/production-calendar.js` | Apresenta backlog, calendário mensal/semanal, Gantt e edição da programação. |
| `dist/js/modules/operations-admin.js` | Apresenta cadastros e formulários, mantém o estado da aba interna e envia mudanças ao repositório. |

### Ordem de carregamento

O final do `index.html` carrega, nesta ordem: cliente HTTP, emissor, repositórios, regras de compatibilidade, navegação, planejamento e cadastros. Os arquivos são scripts clássicos para manter a aplicação sem compilador; por isso cada módulo publica uma API pequena em `window.PRELUX_*`.

## Fluxos principais

### Etiquetas

O formulário atualiza o canvas. Ao salvar, o registro vai para `localStorage` do navegador, não para a base Supabase. PNG, ZIP e impressão também são processados no navegador. Esse comportamento foi mantido como estava.

### Planejamento e cadastros

1. A tela chama o repositório da sua área.
2. O repositório escolhe a Edge Function e a ação correspondente.
3. `core/api.js` adiciona os cabeçalhos públicos, envia JSON e trata o resultado HTTP.
4. A Edge Function valida a entrada e usa funções de `supabase/functions/_shared`.
5. O backend usa o cliente administrativo do Supabase para persistir no PostgreSQL.

A chave `service_role` permanece no servidor. A chave anônima que existe no HTML é pública e não substitui as políticas de acesso do banco.

### Compatibilidade entre peça e molde

O serviço `mold-compatibility.js` implementa o padrão Strategy. A estratégia depende do tipo selecionado:

- **Braço:** lista apenas registros do catálogo `BRACO`.
- **Pilar e Viga:** lista combinações da view `piece_mold_combinations`; se ela não puder ser carregada, gera LEITO × LATERAL a partir do catálogo já carregado.

O backend continua validando os vínculos no salvamento. A lista do navegador é para orientar a escolha, não para substituir a validação do servidor.

### Navegação entre módulos

`navigation.js` controla o estado visível das três abas e dispara `prelux:planning:open` ou `prelux:operations:open`. Os módulos escutam esses eventos e atualizam seus próprios dados. Assim, um módulo não precisa importar nem chamar diretamente as funções internas do outro.

## Supabase e regras de negócio

- `supabase/functions/operations-admin/index.ts` atende as operações de cadastro e reutiliza `piece-metrics.js` e `order-planning.js`.
- `calendar-admin`, `plan-order`, `commit-order-plan` e `rebuild-calendar` compõem o fluxo de planejamento.
- `planner.js`, `calendar.js`, `order-planning.js` e `piece-metrics.js` guardam regras reutilizadas no servidor.
- As migrações em `database/` são históricas e não foram alteradas nesta reorganização.
- Os status existentes continuam aceitos como antes. Não foi criada uma matriz de transições porque o código atual não define quais mudanças de status devem ser proibidas.

## Cache do aplicativo

`dist/sw.js` lista os arquivos necessários para abrir o app e usa o nome do cache para identificar uma versão. Ao alterar arquivos publicados, atualize os parâmetros de versão no HTML e o nome do cache no service worker; isso faz os navegadores baixarem os arquivos novos.
