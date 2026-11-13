# Estado atual do banco PRELUX / Fábio II

**Levantamento feito em 11/11/2026**, após aplicar a migration 012, no Supabase ativo, complementado pelo código e pelas migrations do repositório. Este arquivo registra o que existe hoje; não é uma proposta de novo schema.

## Resumo: o que existe e o que está vazio

As referências de **leito, lateral e braço continuam no banco**. O que está vazio são os cadastros operacionais de tipos de peça, pedidos e vínculos de compatibilidade.

| Dados no Supabase ativo | Quantidade | Observação |
|---|---:|---|
| Organizações | 1 | Organização PRELUX usada pelo servidor. |
| Clientes | 4 | Nomes omitidos deste resumo. |
| Obras | 1 | Obra O.0000, em planejamento. |
| Pedidos / itens | 0 / 0 | Não há pedidos ativos ou antigos nas tabelas. |
| Categorias / tipos de peça | 0 / 0 | Não existem registros de braço, pilar, viga ou placa. |
| Catálogo global de formas | 15 | 7 leitos, 5 laterais e 3 braços fixos; tabela **mold_catalog**. |
| Combinações de catálogo | 73 | View calculada: 3 braços, 35 pares para pilar e os mesmos 35 para viga. |
| Compatibilidades por tipo de peça | 0 | Tabela **piece_type_molds**; volta a ter linhas quando tipos forem cadastrados. |
| Formas físicas cadastradas | 0 | Tabela **molds**, diferente do catálogo de medidas. |
| Posições | 4 | P01 a P04; todas disponíveis. As posições são espaços físicos e recebem as formas conforme o pedido planejado. |
| Constantes de cálculo | 4 | Densidade, horário inicial, duração da concretagem e duração da cura. |
| Tempos de produção por peça | 0 | Ainda não existem **production_minutes_braco**, **production_minutes_pilar** ou **production_minutes_viga**. |
| Configuração de capacidade diária | 0 | **calendar_settings** não tem registro; a coluna tem padrão de 480 minutos/dia. |
| Calendário de produção | 443 dias | Linhas já geradas em **calendar_days**. |
| Projetos, seções, unidades de produção e alocações | 0 | O fluxo ainda não tem pedidos para alimentar essas tabelas. |

### Constantes de cálculo atualmente gravadas

| Chave | Valor | Unidade | Uso |
|---|---:|---|---|
| concrete_density_t_m3 | 2,5 | t/m³ | Densidade de concreto registrada. |
| casting_start_hour | 8 | h | Horário inicial padrão da concretagem. |
| casting_duration_minutes | 120 | min | Duração inicial da concretagem. |
| curing_duration_hours | 12 | h | Duração inicial da cura. |

A obra O.0000 está registrada com início em **03/11/2026**, prazo previsto em **02/02/2027** e status **planejamento**. Há quatro clientes cadastrados; este documento não expõe dados pessoais.

### Catálogo de formas que está no banco

Os rótulos numéricos são tratados pela interface em centímetros. Os códigos são as chaves estáveis usadas nos vínculos.

| Tipo | Código | Medida exibida |
|---|---|---:|
| LEITO | LEITO_20 | 20 cm |
| LEITO | LEITO_25 | 25 cm |
| LEITO | LEITO_30 | 30 cm |
| LEITO | LEITO_35 | 35 cm |
| LEITO | LEITO_40 | 40 cm |
| LEITO | LEITO_50 | 50 cm |
| LEITO | LEITO_60 | 60 cm |
| LATERAL | LATERAL_25 | 25 cm |
| LATERAL | LATERAL_30 | 30 cm |
| LATERAL | LATERAL_40 | 40 cm |
| LATERAL | LATERAL_50 | 50 cm |
| LATERAL | LATERAL_60 | 60 cm |
| BRAÇO fixo | BRACO_25X35 | 25 × 35 cm |
| BRAÇO fixo | BRACO_25X52 | 25 × 52 cm |
| BRAÇO fixo | BRACO_30X60 | 30 × 60 cm |

### Como as combinações são formadas

A view **piece_mold_combinations** não grava moldes novos: consulta o catálogo e monta as opções atuais.

| Tipo de peça | Regra | Opções atuais |
|---|---|---:|
| Braço | Usa uma forma fixa do tipo BRACO. | 3 |
| Pilar | Cada LEITO combinado com cada LATERAL. | 7 × 5 = 35 |
| Viga | Cada LEITO combinado com cada LATERAL. | 7 × 5 = 35 |
| Placa | Não usa forma; usa posição plana. | 0 |

A lista de pares de leito e lateral é a mesma para pilar e viga:

| LEITO × LATERAL | 25 | 30 | 40 | 50 | 60 |
|---:|---:|---:|---:|---:|---:|
| 20 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 25 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 30 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 35 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 40 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 50 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 60 | ✓ | ✓ | ✓ | ✓ | ✓ |

Exemplo da chave de um par: LEITO_20|LATERAL_25. O braço **não** participa desse produto cartesiano; só serve para peça do tipo braço.

## Fórmulas que o código usa

As dimensões X, Y e Z são informadas em centímetros. O código calcula sem arredondar os valores intermediários; a interface só formata a exibição.

### Peça prismática

- Volume em cm³: **V = X × Y × Z**
- Volume em m³: **Vₘ³ = V₍cm³₎ ÷ 1.000.000**
- Massa em kg: **Pₖg = V₍cm³₎ × 2,5 ÷ 1.000**
- Equivalente em toneladas: **Pₜ = V₍m³₎ × 2,5**

A densidade usada pelo código é **2,5 g/cm³**, equivalente a **2.500 kg/m³** ou **2,5 t/m³**. Há uma constante com esse valor no banco, mas as funções de cálculo atuais também mantêm 2,5 fixo no código; editar só a constante não altera o resultado calculado.

### Placa

Para placa, a convenção aprovada é X = largura, Y = altura e Z = espessura:

- Área: **Aₘ² = X × Y ÷ 10.000**
- Volume: **V₍cm³₎ = X × Y × Z**
- Volume em m³: **Vₘ³ = V₍cm³₎ ÷ 1.000.000**
- Peso em kg: **Pₖg = V₍cm³₎ × 2,5 ÷ 1.000**

O banco aceita **piece_kind = placa** e tem uma ação própria **save_plate_type**. A ação integrada de cadastro rápido de pedido + peça aceita apenas braço, pilar ou viga; placa segue pelo cadastro próprio.

### Fórmulas estruturais do consolo que não estão no banco

O arquivo enviado anteriormente, **formulas_consolos_pre_moldados.md**, propõe uma tabela **structural_formulas**, mas essa tabela **não existe** no Supabase e o app **não avalia** essas expressões. O arquivo declara ter transcrito itens da ABNT NBR 9062:2017; o resumo abaixo registra o conteúdo recebido, sem validação normativa independente. As cláusulas são as citadas no anexo.

- Consolo curto, 0,5 < a/d ≤ 1: Asv = (0,1 + a/d) × Fd / fyd; Astir = Asv + Hd/fyd (anexo: 7.3.5.3).
- Consolo muito curto, a/d ≤ 0,5: Asv = 0,8 × Fd/(μ × fyd); Astir = Asv + Hd/fyd (anexo: 7.3.5.4). O anexo indica μ = 1,4 para monolítico, 1,0 para interface especificada e 0,6 para interface lisa.
- Taxa mecânica do tirante: ω = (Astir/(b × d)) × fyk/fck; exigir ω > 0,04 para a/d ≤ 2 (anexo: 7.3.5.2).
- Biela: σ = Rcd/(b × h_biela); com carga apenas vertical, Rcd = Fd/sen(θ). O anexo indica limites σ ≤ fcd para carga direta e σ ≤ 0,85 × fcd para carga indireta (anexo: 7.3.4.1).
- Costura: para consolo curto, As_cost/(2d/3) ≥ 0,4 × Asv/d; para muito curto, o fator é 0,5 (anexo: 7.3.6).
- Armadura transversal mínima: As_transversal_min = 0,0015 × bw × h (anexo: 7.3.7.2).
- Suspensão para reação indireta: As_susp ≥ Rind_d/fyd (anexo: 7.3.8).
- Estimativas de força horizontal listadas no anexo: junta seca 0,8Fd; argamassa 0,5Fd; elastômero 0,16Fd; PTFE 0,08Fd; chapas não soldadas 0,25Fd; concreto sobre chapa 0,4Fd (anexo: 7.3.9).
- Consolo longo, 1 < a/d ≤ 2: o anexo orienta dimensionar como viga em balanço, verificando flexão e cisalhamento (anexo: 7.3.2.2(a)).

O próprio anexo exclui uma fórmula de cisalhamento para consolo muito curto porque a leitura OCR não era segura. Nenhuma dessas fórmulas estruturais deve ser tratada como regra executável do sistema neste momento.

## Como as etapas se conectam

O banco não tem uma tabela chamada “etapas”. As etapas do processo são representadas pelas entidades abaixo:

~~~mermaid
flowchart LR
  C[clients] --> W[works]
  C --> O[orders]
  W -. herda cliente e início .-> O
  O --> I[order_items]
  PT[piece_types] --> I
  O --> EP[engineering_projects 0..1]
  EP --> S[project_sections]
  S --> SI[project_section_items]
  I --> SI
  I --> PO[production_orders 1 por unidade]
  PO --> ST[production_order_steps]
  PO --> A[allocations]
  MP[mold_positions] --> A
  MC[mold_catalog global] --> VIEW[piece_mold_combinations view]
  MC --> PTM[piece_type_molds]
  MC -. códigos de configuração .-> MP
  CAL[calendar_days + calendar_settings] --> PLAN[planejamento]
  PLAN --> PO
  PO --> LABEL[etiqueta, hoje sem vínculo automático]
~~~

### 1. PEDIDO

- **works** guarda obra, número, cliente, endereço, datas e status. Uma obra pode ter muitos pedidos.
- **orders** é o pedido. **work_id** é opcional. Quando há obra, a trigger **inherit_order_work_fields** copia cliente e data de início da obra; a trigger da obra sincroniza pedidos ainda não iniciados em produção. Mudanças depois do início de produção são bloqueadas.
- Sem obra, o cliente e a data de início do pedido são informados manualmente.
- **order_items** liga um pedido a um ou mais tipos de peça e guarda quantidade, sequência e observações.

### 2. ENGENHARIA

- A validação consulta o tipo da peça e a configuração compatível do catálogo.
- **piece_type_molds** grava, por tipo de peça, a escolha dos códigos de catálogo. Hoje a tabela está vazia porque **piece_types** também está vazia.
- Essa conferência está dentro do fluxo de PEDIDOS no app; não é uma área independente.

### 3. PROJETO

- **engineering_projects** permite no máximo um projeto por pedido.
- **project_sections** divide o projeto em seções; **project_section_items** liga cada seção ao item do pedido e registra quantidade.
- A soma distribuída de cada item precisa ser exatamente igual à quantidade pedida. A gravação do projeto e da distribuição é transacional.
- Pedido sem projeto usa a gravação de pedido e itens. Pedido já projetado atualiza pedido, itens e seções na mesma operação.

### 4. PRODUZIR / PLANEJAMENTO

- **production_orders** representa cada unidade planejada de um item; **production_order_steps** guarda as etapas e seus horários.
- As etapas de produção incluem concretagem, cura, acabamento, inspeção e liberação. A concretagem começa às 08:00 como valor configurado; dura 120 minutos. A cura tem valor inicial de 12 horas.
- **allocations** reserva uma posição durante o intervalo de concretagem e cura. A compatibilidade de BRAÇO, LEITO e LATERAL vem do item do pedido; a mesma posição física pode receber configurações diferentes em períodos distintos.
- **calendar_days** e **calendar_settings** descrevem dias úteis e capacidade. A área PLANEJAMENTO apresenta o resultado calculado a partir dos pedidos.
- Se não houver posição livre no período, o pedido pode ser salvo e fica aguardando posição; ele não recebe alocação até replanejar.

### ETIQUETAS

A etapa **Etiquetas** fica dentro de Pedidos. Quando todas as unidades de um pedido ficam prontas, uma trigger grava uma etiqueta por unidade em `production_labels`. ID, cliente e observações são retratos dos dados do pedido e da peça. A tela lê esses registros do Supabase e permite prévia, PNG, ZIP e impressão. O editor de etiquetas avulsas mantém seu histórico no **localStorage** do navegador. As caixas de liberação/reparo/bloqueio do modelo impresso continuam para conferência manual.

## Contrato entre interface, Edge Functions e banco

O caminho atual de uma gravação é:

~~~text
Tela → repositório JavaScript → api.js → Supabase Edge Function → RPC PostgreSQL/tabelas
~~~

- A tela não consulta tabelas diretamente. Os repositórios em **dist/js/repositories/** chamam **invoke()** em **dist/js/core/api.js**.
- A chamada HTTP usa POST em **/functions/v1/<nome-da-função>**, JSON, a chave pública anon em **apikey** e **Authorization: Bearer**. Não há tela de login.
- O navegador nunca deve conter **SUPABASE_SERVICE_ROLE_KEY**. As Edge Functions leem essa chave e **PRELUX_ORGANIZATION_ID** do ambiente do servidor e acessam o banco como **service_role**.
- **organizationId** confiável vem da configuração do servidor; o campo enviado pelo navegador não escolhe a unidade.
- Resposta bem-sucedida tem **ok: true** e os dados da operação. Erros são normalizados no cliente como mensagem HTTP e detalhes.
- A migration 009 revoga execução pública das RPCs administrativas e concede o acesso ao **service_role**. A view de combinações também é restrita ao serviço.

### Ações HTTP mais importantes

**operations-admin**

- **bootstrap**: retorna clientes, obras, pedidos, itens, tipos de peça, catálogo, combinações, posições e dados do Fábio II.
- **save_work**: grava obra e pode recalcular pedidos abertos.
- **save_order**: grava pedido e itens; em pedido já projetado, também persiste suas seções na mesma operação.
- **create_order_piece_registration**: cadastra obra, peça, pedido e item; solicita simulação de planejamento e gravação atômica pela RPC **create_order_piece_registration**.
- **save_engineering_project**: salva o projeto e a divisão por seções pela RPC **save_engineering_project_structure**.
- **save_piece_type** / **save_plate_type**: cadastram tipos de peça e medidas; a placa tem ação própria.
- **save_position**: mantém status e observações da posição física. Os moldes são definidos pelo item do pedido e associados à posição durante o planejamento.
- Também há ações para preparação/alocação de formas, ajuste de prazo, cálculo de métricas e arquivamento.

#### Campos do cadastro integrado de pedido + peça

A ação **create_order_piece_registration** recebe campos simples no mesmo corpo JSON. Os principais são:

- Obra/cliente: **workNumber**, **workName**, **responsibleName**, **address**, **clientName**, **startDate** e, se alterado manualmente, **requestedDueDate** com **requestedDueDateManual = true**.
- Peça: **pieceKind** (braco, pilar ou viga), **pieceCode**, **pieceName**, **dimensionXcm**, **dimensionYcm**, **dimensionZcm** e **quantity**.
- Compatibilidade: **bracoCatalogCode** para braço; **leitoCatalogCode** e **lateralCatalogCode** para pilar/viga.
- Opcionais: **orderObservations**, **itemObservations** e **pieceObservations**.

O servidor valida a entrada, calcula as métricas, consulta os tempos por tipo, simula posições e chama a RPC com a unidade e o pacote completo. A resposta inclui os dados registrados e **planning** com waitingForPosition, feasible, plannedUnitCount e aviso, quando aplicável. O número PED definitivo é gerado no banco, não recebido do navegador.

**calendar-admin**

- **get**, **planning_data**, **get_settings**: leem calendário, configurações e dados de planejamento.
- **save_settings**, **save_activity**, **save_day**, **delete_activity**: mantêm as configurações e exceções/dias do calendário.

**Planejamento**

- **plan-order** simula uma programação.
- **commit-order-plan** grava/confirma uma programação.
- **rebuild-calendar** gera dias do calendário.
- A RPC **commit_planning_queue** grava unidades, etapas, alocações e resumo legado em uma transação.

### Regras de validação e integridade mais importantes

- Código de catálogo e tipo de forma são estáveis; medida e ordem podem ser editadas. A alteração da medida é bloqueada quando uma peça/pedido ou produção ativa a utiliza, e fica registrada em **audit_logs**.
- A posição física não escolhe uma configuração permanente para braço, pilar ou viga. Braço usa BRAÇO para X × Z; pilar/viga usam LEITO para X e LATERAL para Z, com Y como comprimento. O planejador associa esses moldes à primeira posição livre no período. Bancadas planas continuam reservadas para placas. A etapa atual não reserva um **molds.id** individual.
- Preparação de forma dura cinco dias úteis do calendário.
- Quantidades de item e seções são inteiros positivos; dimensões X/Y/Z devem ser positivas em centímetros.
- Número sequencial de pedido é gerado pelo banco como **PED-0001**, **PED-0002** etc.; há unicidade por organização para esse formato. A prévia no navegador não é a autoridade.
- Prazo sugerido é início + 90 dias corridos; uma data manual pode substituir o padrão, mas não pode anteceder o início.
- Status desejados de pedido: **orcamento**, **aprovado**, **em_producao**, **entregue**, **atrasado**, **cancelado**. O enum ainda contém o valor legado **concluido**, mas a constraint impede novos usos. Hoje não há pedidos na tabela.
- O cálculo de minutos por unidade é separado da capacidade diária. Os três valores **production_minutes_*** precisam ser configurados antes do cadastro integrado de pedido/peça; atualmente estão ausentes.

## O que pode ser recuperado agora e o que continua faltando

1. **Já presente:** os 15 códigos do catálogo, as 73 combinações calculadas, quatro posições, a obra O.0000, quatro clientes e as quatro constantes existentes. Não foi necessário regravar estes dados.
2. **Ausente no banco atual:** tipos de peça, pedidos, itens, moldes físicos, vínculos de compatibilidade, projetos e planos de produção. As contagens atuais são zero.
3. **Não há uma branch de recuperação do Supabase listada pelo conector.** O repositório contém schema, migrations e regras, mas não contém cópia dos antigos registros de tipos de peça com códigos, nomes e dimensões. Não é possível reconstruir esses registros com fidelidade só pelo código.
4. **Nenhuma restauração de projeto/banco foi executada neste levantamento.** A restauração do projeto não foi acionada, porque o ponto de recuperação não foi indicado e os registros presentes não devem ser substituídos por uma cópia antiga por tentativa.
5. Para recuperar tipos/pedidos realmente apagados, é necessário localizar um backup/exportação com os registros ou confirmar um ponto de restauração do Supabase. Até lá, não inventar dimensões nem códigos.

## Divergência documental encontrada

O histórico ativo do Supabase contém as migrations **008** (20261028160556), **009** (20261106144221) e **010** (20261111133923, `remove_composed_geometry`). A migration 010 substituiu a RPC de cadastro: novas peças usam volume X × Y × Z, peso calculado pela densidade existente e `custom_fields` vazio. A migration 009 permanece intacta como histórico. Alguns documentos ainda descrevem 009 como não aplicada; essas frases estão desatualizadas.

## Referências consultadas

- Supabase ativo do projeto PRELUX: schema, migrations e consultas SQL de leitura.
- Migrations locais: database/001_initial_schema.sql a database/010_remove_composed_geometry.sql.
- Código da interface: dist/js/core/, dist/js/repositories/, dist/js/domain/ e dist/js/features/.
- Edge Functions: supabase/functions/operations-admin/, calendar-admin/, plan-order/, commit-order-plan/ e rebuild-calendar/.
- Fórmulas recebidas no arquivo formulas_consolos_pre_moldados.md.
