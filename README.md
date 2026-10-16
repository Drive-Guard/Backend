# DriveGuard — Backend

API da dashboard e trabalhos em segundo plano do DriveGuard, em **TypeScript** sobre
**AWS Lambda**, publicados com o [osls](https://github.com/oss-serverless/serverless)
(fork mantido do Serverless Framework v3, que não exige login nem licença) a partir de
um único `serverless.ts`.

A infraestrutura de base (VPC, RDS PostgreSQL, Cognito, API HTTP com autorizador JWT,
buckets) é do repositório [Drive-Guard/Infra](https://github.com/Drive-Guard/Infra).
Este repositório só cria as Lambdas e pendura as rotas na API que o Terraform criou.

```
                 ┌──────────────── API HTTP (Terraform) + autorizador JWT (Cognito) ───────────────┐
 dashboard  ──►  │ dashboard · motoristas · alertas · relatorios · cadastros   (VPC, leem o RDS)   │
 (SPA)           │ usuarios                                                    (fora da VPC: Cognito)│
                 └─────────────────────────────────────────────────────────────────────────────────┘

 EventBridge (1 h)  ─► insightsContexto (VPC) ─► S3 insights/contextos/ ─► insightsIa (fora: Gemini/regras)
                                                                              │
                        insightsGravar (VPC) ◄─ S3 insights/respostas/ ◄──────┘
 EventBridge (15 min) ─► agendamentos (VPC) ─► S3 relatorios/envios/ ─► relatorioEnviar (fora: SES)
                                                                              │
                        relatorioStatus (VPC) ◄─ S3 relatorios/resultados/ ◄──┘
```

**Regra do projeto:** quem fala com a internet roda fora da VPC; quem fala com o banco
roda dentro; os dois trocam arquivos pelo S3 (eventos "Object Created" pelo
EventBridge). Assim não é preciso NAT Gateway (≈ US$ 32/mês), fora do orçamento do
AWS Academy Learner Lab.

## O que a API entrega

As rotas ficam em [`src/rotas.ts`](src/rotas.ts), a fonte única de verdade: o
`serverless.ts` gera os eventos `httpApi` de cada Lambda a partir dela e o roteador de
cada Lambda confere o papel do usuário com ela.

Papéis (grupos do Cognito): **admin** (tudo), **gestor** (visão gerencial, ROI,
relatórios e cadastros) e **operador** (visão técnica: monitoramento e alertas).
Toda consulta filtra pela empresa do usuário (`custom:empresa_id` do token).

**dashboard**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/me` | todos | Usuário logado, papéis e empresa |
| GET | `/dashboard/kpis` | todos | KPIs do topo (ao vivo e do período) |
| GET | `/dashboard/alertas-tempo-real` | todos | Motoristas com fadiga alta agora |
| GET | `/dashboard/tendencia-turno` | todos | Fadiga média por hora de direção e sinais detectados |
| GET | `/dashboard/evolucao-fadiga` | todos | Fadiga média diária no período |
| GET | `/dashboard/rotas` | todos | Rotas com maior incidência, com o cruzamento da PRF |
| GET | `/dashboard/heatmap` | todos | Horas de direção x dia (últimos 7 dias ou intervalo) |
| GET | `/dashboard/fadiga-tempo-direcao` | todos | Fadiga e alertas por faixa de horas ao volante |
| GET | `/dashboard/prf/resumo` | todos | Resumo da base da PRF carregada |
| GET | `/dashboard/prf/faixa-horaria` | todos | Acidentes por faixa horária (PRF) |
| GET | `/dashboard/prf/causas` | todos | Principais causas de acidentes (PRF) |
| GET | `/dashboard/prf/mapa` | todos | Cidades com mais acidentes por sono (PRF) |
| GET | `/dashboard/insights` | todos | Insights e recomendações mais recentes |
| POST | `/dashboard/insights/gerar` | admin, gestor | Pede uma nova rodada de insights |
| GET | `/dashboard/roi` | admin, gestor | Impacto estimado (ROI) com fontes |
| GET | `/dashboard/exportar` | todos | CSV com o estado atual dos motoristas |

**motoristas**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/motoristas/ao-vivo` | todos | Lista ao vivo dos motoristas |
| GET | `/motoristas/{id}` | todos | Indicadores de 30 dias e estado atual |
| GET | `/motoristas/{id}/curva-turno` | todos | Fadiga hora a hora no último turno |
| GET | `/motoristas/{id}/insights` | todos | Insights do motorista |
| GET | `/motoristas/{id}/alertas` | todos | Alertas recentes do motorista |
| POST | `/motoristas/{id}/acoes` | todos | Registra uma ação (ex.: pausa solicitada) |
| POST | `/motoristas/{id}/ocorrencias` | todos | Registra uma ocorrência interna |

**alertas**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/alertas` | todos | Alertas da frota |
| PATCH | `/alertas/{id}` | todos | Reconhece, resolve ou descarta um alerta |

**relatorios**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/relatorios/resumo` | admin, gestor | KPIs, gráficos e resumo inteligente do período |
| GET | `/relatorios` | admin, gestor | Relatórios gerados |
| POST | `/relatorios` | admin, gestor | Gera um relatório (PDF, Excel ou CSV) |
| GET | `/relatorios/{id}/download` | admin, gestor | Link temporário para baixar o arquivo |
| GET | `/relatorios/agendamentos` | admin, gestor | Agendamentos de envio |
| POST | `/relatorios/agendamentos` | admin, gestor | Cria um agendamento |
| PUT | `/relatorios/agendamentos/{id}` | admin, gestor | Altera um agendamento |
| DELETE | `/relatorios/agendamentos/{id}` | admin, gestor | Remove um agendamento |

**cadastros**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/cadastros/empresa` | admin, gestor | Dados da empresa |
| PUT | `/cadastros/empresa` | admin, gestor | Altera nome e tamanho da frota |
| GET | `/cadastros/ufs` | todos | UFs e macro-regiões |
| GET | `/cadastros/motoristas` | admin, gestor | Motoristas cadastrados e não cadastrados |
| POST | `/cadastros/motoristas` | admin, gestor | Cadastra (ou completa) um motorista pelo código |
| PUT | `/cadastros/motoristas/{id}` | admin, gestor | Altera um motorista |
| GET | `/cadastros/veiculos` | admin, gestor | Veículos e a câmera de cada um |
| POST | `/cadastros/veiculos` | admin, gestor | Cadastra um veículo |
| PUT | `/cadastros/veiculos/{id}` | admin, gestor | Altera um veículo |
| GET | `/cadastros/dispositivos` | admin, gestor | Câmeras (inclusive as pendentes) |
| POST | `/cadastros/dispositivos` | admin, gestor | Pré-cadastra uma câmera |
| PUT | `/cadastros/dispositivos/{id}` | admin, gestor | Altera código, descrição ou status da câmera |
| POST | `/cadastros/dispositivos/{id}/vincular` | admin, gestor | Instala a câmera num veículo (troca, se já estiver em outro) |
| POST | `/cadastros/dispositivos/{id}/desvincular` | admin, gestor | Retira a câmera do veículo |
| GET | `/cadastros/dispositivos/{id}/historico` | admin, gestor | Em quais veículos a câmera esteve |
| GET | `/cadastros/rotas` | admin, gestor | Rotas |
| POST | `/cadastros/rotas` | admin, gestor | Cadastra uma rota |
| PUT | `/cadastros/rotas/{id}` | admin, gestor | Altera uma rota |
| GET | `/cadastros/viagens` | admin, gestor | Viagens |
| POST | `/cadastros/viagens` | admin, gestor | Cadastra uma viagem |
| PUT | `/cadastros/viagens/{id}` | admin, gestor | Altera ou cancela uma viagem |
| GET | `/cadastros/parametros-roi` | admin, gestor | Parâmetros do ROI com as fontes |
| PUT | `/cadastros/parametros-roi/{chave}` | admin, gestor | Define o valor da empresa para um parâmetro |
| DELETE | `/cadastros/parametros-roi/{chave}` | admin, gestor | Volta o parâmetro ao valor padrão |

**usuarios**

| Método | Caminho | Papéis | O que faz |
|---|---|---|---|
| GET | `/usuarios` | admin | Usuários da empresa |
| POST | `/usuarios` | admin | Cria um usuário com senha temporária |
| PATCH | `/usuarios/{username}` | admin | Troca o papel ou ativa/desativa |
| DELETE | `/usuarios/{username}` | admin | Remove o usuário |
| POST | `/usuarios/{username}/redefinir-senha` | admin | Gera uma nova senha temporária |

Filtros comuns na query string: `periodo` (`hoje`, `7d`, `30d`, `90d`, `ano`) ou
`de`/`ate` (AAAA-MM-DD), `regiao` (macro-região ou UF) e `tipo_veiculo`
(`caminhao`, `onibus`, `van`, `carro_app`). Os dias são de Brasília.

### Decisões que valem citar

- **Somas, não médias.** As views Gold guardam somas e contagens; a API recompõe a
  média do período. Média de médias daria número errado ao juntar dias e regiões.
- **PRF como base comparativa.** Os 12 meses mais recentes da base aberta da PRF,
  por padrão só acidentes com veículos pesados, sempre identificados como
  "Fonte: PRF". O horário crítico vem dos alertas da própria frota.
- **ROI com fontes.** `GET /dashboard/roi` mostra cada parâmetro com a fonte
  (IPEA 2015, AAA Foundation, estudo de razão de taxas 0,5, IPCA do Banco Central,
  perfil dos acidentes de caminhão/ônibus com condutor dormindo da PRF) e dois
  cenários (fração de sono registrada pela PRF e medida em investigação aprofundada).
  O gestor troca qualquer parâmetro editável em Cadastros.
- **Insights por IA com pseudonimização.** O contexto enviado ao modelo só tem
  códigos (DRV-1000, TRK-1045), nunca nome, CPF ou placa. O AWS Academy nega o
  Bedrock à LabRole, então o modelo é o Gemini (camada gratuita). Sem chave, com
  cota esgotada ou resposta fora do schema, o mesmo contexto passa pelas regras.
- **Relatórios** em PDF (pdf-lib), Excel (exceljs) e CSV, gerados na própria
  requisição. O envio por e-mail é assíncrono (SES); sem SES — o Learner Lab bloqueia —
  o envio fica registrado como falho e o relatório continua disponível na dashboard.

## Desenvolvimento local

Pré-requisito: Node.js 22+ e o repositório Infra ao lado deste (`../Infra`), de onde
vêm os scripts SQL.

```bash
npm install
npm run db:local      # terminal 1: PostgreSQL 16 em localhost:54329 (binários oficiais, sem Docker)
npm run dev:api       # terminal 2: aplica as migrações + seed e sobe a API em http://localhost:3001
```

O servidor de desenvolvimento roda as **mesmas** Lambdas da nuvem. Diferenças:
autenticação com `Authorization: Bearer dev:admin` (ou `dev:gestor`, `dev:operador`),
arquivos em `.arquivos/` com a cadeia de workers executada na hora, e usuários em
memória (sem Cognito).

```bash
curl -H "Authorization: Bearer dev:gestor" http://localhost:3001/dashboard/kpis
npm run db:resemear   # refaz a frota de demonstração (a base da PRF carregada fica)
npx tsx scripts/exemplo-relatorio.ts executivo pdf exemplo.pdf
```

## Testes

```bash
npm run db:local   # em outro terminal
npm test
```

Os testes rodam contra um PostgreSQL 16 de verdade (banco `driveguard_backend_test`,
criado do zero com os scripts do Infra, o seed e uma amostra da PRF): rotas pelo
handler das Lambdas, isolamento entre empresas, cadastros (câmera pendente, troca de
veículo), ROI conferido contra a fórmula, os 15 relatórios (5 tipos × 3 formatos),
agendamentos, cadeia de insights com IA simulada e fallback, e usuários.

## Deploy

Pré-requisitos: `terraform apply` do repositório Infra concluído (ele cria a API, o
Cognito e os parâmetros em `/driveguard-dev/backend/` no SSM) e credenciais da AWS
no ambiente.

```bash
npm run print     # confere a configuração resolvida a partir do SSM
npm run deploy    # build (esbuild) + osls deploy --stage dev
npm run remove    # remove o stack (o scripts/desligar do Infra já faz isso antes do destroy)
```

No Learner Lab não há permissão para criar roles: todas as funções usam a `LabRole`
(`provider.iam.role`). A chave do Gemini, se houver, fica no parâmetro SecureString
`/driveguard-dev/backend/ia_api_key` (pode ser trocada no console sem novo deploy do
Terraform; o deploy do backend relê o valor).

## Estrutura

```
serverless.ts          funções, VPC, eventos (gerados de src/rotas.ts)
src/rotas.ts           manifesto das rotas e papéis
src/funcoes/           ponto de entrada de cada Lambda (API por domínio e workers)
src/servicos/          regras de negócio e SQL (dashboard, motoristas, ROI, insights, relatórios...)
src/lib/               banco (postgres.js + TLS do RDS), auth, filtros, datas, S3, roteador
scripts/               build, PostgreSQL local, migração, servidor de desenvolvimento
test/                  vitest contra PostgreSQL real
```
