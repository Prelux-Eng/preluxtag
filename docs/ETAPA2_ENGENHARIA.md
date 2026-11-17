# PRELUX / Fábio II — Etapa 2: Engenharia

**Estado:** implementação local pronta para revisão. A migration e a nova Edge Function não foram aplicadas/publicadas no Supabase ativo.
**Decisões mantidas:** densidade de 2.500 kg/m³; medidas em centímetros; catálogo existente reaproveitado; braço usa uma forma BRAÇO; pilar/viga usam LEITO × LATERAL; placa usa bancada plana.

## O que entrou

1. `engineering-domain.js` contém regras puras sem Supabase, HTTP ou interface: valida parâmetros, calcula volume/peso, lista compatibilidades e valida seleção de formas.
2. `piece-metrics.js` e `plate-metrics.js` viraram adaptadores compatíveis com os chamadores existentes. As fórmulas continuam iguais. Agora aceitam a densidade lida da versão de Engenharia.
3. `engineering-repository.js` concentra consultas ao catálogo, às posições e aos parâmetros vigentes.
4. `engineering-service.js` compõe leituras e regras; `engineering-admin` publica leitura de configuração, lista de formas compatíveis e cálculo de métricas.
5. O endpoint `operations-admin` e o cadastro integrado passam a usar a densidade da versão atual no cálculo.
6. O script aditivo cria `engineering_parameter_versions`, grava a versão usada no pedido aprovado e acrescenta contadores `version` a pedido, tipo de peça, unidade de produção e posição. Cada atualização incrementa o contador.
7. `create_engineering_parameter_version` compara a versão esperada, serializa alterações concorrentes, cria uma linha imutável e registra a versão em `audit_logs`.

## Regras de cálculo e compatibilidade

- `volume_cm3 = X × Y × Z`.
- `volume_m3 = volume_cm3 ÷ 1.000.000`.
- `peso_kg = volume_m3 × densidade_kg_m3`; a primeira versão grava 2.500 kg/m³, equivalente aos 2,5 t/m³ atuais.
- Placa: área `X × Y ÷ 10.000` m²; Z é a espessura e participa do volume e do peso.
- Braço: apenas os códigos `BRACO` do catálogo.
- Pilar e viga: produto cartesiano das 7 medidas LEITO pelas 5 medidas LATERAL, totalizando 35 combinações cada.
- Placa: sem molde; a opção retornada é bancada plana.
- As dimensões precisam ser numéricas, positivas e estar no intervalo que o código atual já aceita. A geometria composta continua fora do sistema.

## Banco e versionamento

O script [`015_engineering_parameter_versions.sql`](../database/015_engineering_parameter_versions.sql) contém:

- parâmetros tipados por organização: dias úteis de preparação, concretagem e acabamento; dias corridos de cura; capacidade diária; limite de prazo; hora inicial; densidade;
- uma versão inicial por organização ativa com os valores previamente aprovados: 5, 1, 2, 1 dias; capacidade 4; prazo 90 dias; início 08:00; densidade 2.500 kg/m³;
- `orders.engineering_parameter_version_id`, imutável após aprovação;
- contadores de versão em pedidos, tipos de peça, unidades e posições;
- RLS ativado e sem policies públicas; execução da RPC limitada a `service_role`.

Os parâmetros técnicos da fila ficam registrados por versão. A integração com o domínio Projeto está concluída localmente e documentada em [`ETAPA3_PROJETO.md`](ETAPA3_PROJETO.md). O campo antigo `production_minutes_per_unit` continua no modelo para compatibilidade e não substitui as etapas por dias.

## Contratos de API

Todos são `POST /functions/v1/engineering-admin` com chave pública; a organização vem da configuração do servidor.

| Ação | Entrada | Retorno |
|---|---|---|
| `get_configuration` | `{ "action": "get_configuration" }` | Versão vigente, parâmetros, catálogo, opções para braço/pilar/viga/placa e estado das posições |
| `list_mold_options` | `{ "action": "list_mold_options", "pieceKind": "pilar" }` | Combinações válidas derivadas do catálogo |
| `calculate_piece_metrics` | `{ "action": "calculate_piece_metrics", "pieceKind": "placa", "dimensions": { "x": 200, "y": 300, "z": 10 } }` | Área quando for placa, dimensões, volume, peso e versão de parâmetros usada |
| `create_parameter_version` | Reservado a chamada administrativa com versão esperada e parâmetros | Retorna HTTP 403 enquanto não houver autenticação por perfil |

O banco aceita nova versão somente por RPC restrita ao `service_role`. A Edge Function não expõe essa escrita: sem login, não existe forma confiável de distinguir Engenharia dos demais visitantes. A aplicação continua sem login nesta fase, conforme decisão anterior. Para habilitar edição dentro do site, será necessário aprovar e implementar autenticação/perfis; não foi criada uma rota pública privilegiada.

## Arquivos desta etapa

- `supabase/functions/_shared/engineering-domain.js`
- `supabase/functions/_shared/engineering-repository.js`
- `supabase/functions/_shared/engineering-service.js`
- `supabase/functions/_shared/piece-metrics.js`
- `supabase/functions/_shared/plate-metrics.js`
- `supabase/functions/engineering-admin/index.ts`
- `supabase/functions/operations-admin/index.ts`
- `supabase/functions/_shared/registration-service.js`
- `database/015_engineering_parameter_versions.sql`
- `tests/engineering-domain.test.mjs`

## Como conferir

Na raiz do repositório:

```powershell
node --test
```

Resultado nesta etapa: **54 testes aprovados, 0 falhas**. Os casos novos cobrem fórmulas, validação de medidas e parâmetros, densidade versionada, 35 combinações, braço fixo, placa sem forma e consistência das opções usadas pela interface.

O SQL foi revisado no repositório, mas não foi executado contra o banco ativo. O comando Supabase CLI não está instalado neste ambiente; por isso o script segue a sequência local `database/015` e ainda precisa ser convertido para uma migration padrão do Supabase antes de publicação. A Edge Function e as mudanças que dependem da tabela também precisam ser publicadas somente depois da migration.

## Pendências para revisão

- A versão atual alimenta os cálculos de cadastro; o domínio Projeto recebe a versão correspondente ao pedido aprovado ou a versão vigente quando simula um orçamento.
- Os contadores são incrementados no banco; as telas ainda precisam enviar `expectedVersion` nos comandos de edição de pedido, tipo de peça e posição para rejeitar de fato uma gravação baseada em tela desatualizada.
- A autoria individual da alteração não pode ser gravada sem login. O log atual identifica a chamada como `sistema-sem-login`.
- A política de catálogo editável continua conforme a decisão anterior; a regra conflitante do anexo que o declara imutável permanece pendente de resposta.
