# Distributed Wagering Processor

Etapa atual: **E1 — base executável**. A aplicação expõe somente health checks e prepara PostgreSQL, SQS e a extensão de identidade. Money, entidades/tabelas financeiras, operações, consumidores, publisher e triggers ficam para as próximas etapas.

O enunciado original completo foi preservado, sem alterações, em [CHALLENGE.md](CHALLENGE.md). Consulte [PLAN.md](PLAN.md) para etapas e testes obrigatórios e [ARCHITECTURE.md](ARCHITECTURE.md) para decisões, mecanismos e limitações.

## Versões fixadas

| Componente | Versão |
|---|---|
| Bun — runtime, package manager e test runner | 1.4.4 |
| TypeScript | 6.0.3, modo estrito |
| NestJS core/common/platform-express | 12.4.0 |
| MikroORM core/PostgreSQL/migrations/CLI | 7.2.8 |
| Integração MikroORM/NestJS | 7.1.0 |
| AWS SDK SQS | 3.1164.0 |
| PostgreSQL | 17.11-alpine, com digest no Compose |
| LocalStack Community | 4.14.0, com digest no Compose |

As versões e peer dependencies foram consultadas nas fontes oficiais antes da instalação. O projeto usa ESM/NodeNext, compatível com as versões escolhidas de NestJS e MikroORM. Compila com `tsc`, executa JavaScript com Bun e usa `@Inject` explícito. A integração efetiva é verificada pelo smoke test, sem assumir compatibilidade só pelo campo engines. Fontes e justificativas estão na arquitetura.

LocalStack 4.14.0 permite executar SQS local sem token externo. As versões atuais mudaram o modelo de distribuição/autenticação; esta versão antiga está fixada deliberadamente para o exercício. Atualizá-la exige nova avaliação. Não se usa tag latest.

## Preparar e executar

Pré-requisitos: Bun **1.4.4**, Docker Engine e Docker Compose com suporte a `up --wait`. A API roda no host; PostgreSQL e LocalStack rodam nos containers. Não é necessário instalar AWS CLI no host.

Instale a versão de Bun indicada em `.bun-version` usando a [instalação oficial](https://bun.com/docs/installation), se necessário. Depois, na raiz do repositório:

```sh
bun --version
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up
bun run typecheck
bun run build
bun run start
```

O `.env.example` contém apenas valores locais de desenvolvimento: senha de PostgreSQL descartável e credenciais fictícias `test` para LocalStack. `.env` não é versionado. Bun carrega esse arquivo automaticamente. A configuração é validada com Zod antes de iniciar os serviços; erros indicam os nomes dos campos, sem imprimir seus valores.

Por padrão, API em `127.0.0.1:3000`, PostgreSQL em `127.0.0.1:5432` e LocalStack em `127.0.0.1:4566`. Se precisar mudar portas, altere `.env`. Mantenha a porta de SQS_ENDPOINT igual a LOCALSTACK_PORT; PGPORT é usado tanto pela API quanto pelo mapeamento do Compose. HOST é o endereço de escuta da API; PGHOST deve ser o endereço acessível ao processo no host.

Para desenvolvimento com recarga de TypeScript:

```sh
bun run start:dev
```

## Health checks

```sh
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
```

- `live`: 200 e `{"status":"ok"}`, sem consultar dependências.
- `ready`: executa `SELECT 1` pelo MikroORM e consulta via SQS SDK a existência/acessibilidade das três filas. Retorna 200 com os dois checks `up`, ou 503 com a dependência afetada `down`.

Exemplo de readiness saudável:

```json
{"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

`HEALTH_TIMEOUT_MS` vale 1000 por padrão e limita cada probe em paralelo. SQS usa AbortSignal compartilhado e sem retries internos; PostgreSQL tem limites de conexão, query e statement no driver, além do deadline da resposta. Esses limites do driver aplicam-se às consultas desta base E1 e deverão ser revistos ao introduzir migrations/operações mais longas. A API não expõe mensagens internas de conexão na resposta.

Os dois endpoints são abertos. A implementação de desenvolvimento de `ProviderIdentityPort` declara `authenticated: false`; ela está registrada para futura integração OIDC, sem autenticação artesanal. Não há endpoints financeiros usando essa porta ainda.

## Filas locais e inicialização

O hook executável em `scripts/localstack/10-init-sqs.sh` cria:

- `wager-transactions.fifo`;
- `wager-transactions-dlq.fifo`;
- `wager-events.fifo`.

A fila de comandos tem visibility timeout de 30s e redrive policy com `maxReceiveCount = 5`, apontando para o ARN da DLQ. O hook cria primeiro a DLQ, resolve o ARN e configura a fila de comandos. Reexecutá-lo preserva as filas e converge a configuração de redrive/visibilidade:

```sh
bun run infra:queues
docker compose exec -T localstack awslocal sqs list-queues
```

O healthcheck do container só fica saudável depois do hook concluir e a fila de comandos responder. A readiness da API verifica também DLQ e eventos. Isso verifica o provisionamento; retry, redelivery e encaminhamento real para DLQ serão implementados/testados em E10.

## MikroORM e migrations

`allowGlobalContext` está desabilitado. O middleware oficial MikroORM/NestJS cria RequestContext e EntityManager isolados por requisição. A readiness exige esse contexto com `getContext()`; não usa entidades globais compartilhadas.

Execuções fora de HTTP deverão usar `RequestContext.create(orm.em, callback)` ou um fork novo por execução. O smoke test já comprova dois contextos sobrepostos e rejeição do uso global. Não existe wrapper de unidade de trabalho ou repositório genérico nesta etapa.

A extensão Migrator está registrada. Fontes futuras serão versionadas em `src/infrastructure/database/migrations/Migration*.ts`, com `up` e `down`. A CLI executa os arquivos compilados `Migration*.js` sob Bun, usando a mesma configuração validada:

```sh
bun run migration:pending
bun run migration:up
bun run migration:down
```

Em E1 não há migration financeira: `migration:pending` retorna `No pending migrations`. A CLI pode criar apenas sua tabela de controle `mikro_orm_migrations`. O schema financeiro e a comprovação de reversibilidade ficam em E4. Não há schema sync automático na inicialização.

## Validações reproduzíveis

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
bun run migration:pending
bun run test:smoke
```

`bun run test` executa os testes de configuração. `bun run test:smoke` compila, sobe/verifica a infraestrutura e inicia a **API compilada** numa porta temporária. A suíte usa PostgreSQL e LocalStack reais, sem mocks, e verifica:

- health saudável e acesso às três filas;
- atributos FIFO, redrive e reexecução do hook;
- isolamento de EntityManager em execuções sobrepostas;
- ausência de tabelas financeiras;
- readiness 503 e liveness 200 com cada dependência parada, recuperando sem reiniciar a API;
- timeout com cada container pausado, mantendo liveness disponível;
- registro da porta de identidade sem alegar autenticação.

O smoke test interrompe temporariamente **somente os serviços deste Compose** (`wagering-challenge`) e restaura-os ao terminar. Encerra sua própria API; os containers ficam disponíveis. Execute sem outra validação usando esses mesmos serviços em paralelo.

Para verificar uma indisponibilidade manualmente, com a API rodando em outro terminal:

```sh
docker compose stop postgres
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/health/live
docker compose up -d --wait postgres
```

Repita substituindo `postgres` por `localstack`. Readiness deve voltar a 200 após a recuperação. Para parar a infraestrutura preservando o volume PostgreSQL:

```sh
bun run infra:down
```

## Limites desta entrega

PostgreSQL usa volume nomeado. LocalStack é descartável nesta base: recria filas ao iniciar, sem garantia de persistência das mensagens do emulador após seu reinício. Não há mensagens financeiras sendo processadas em E1. O usuário PostgreSQL criado pela imagem é administrativo de desenvolvimento; papéis separados e proteções de schema pertencem a E4.

Não foram implementados Money, ledger, idempotência financeira, operações, workers, publisher, triggers ou métricas financeiras. O desenho futuro desses mecanismos em ARCHITECTURE não constitui evidência de implementação.

Decisões confirmadas: bigint/BIGINT em centavos; replay da primeira resposta/status HTTP, mudando somente idempotentReplay; GET para evolução e resultado terminal histórico; reversão única por referência + tipo, permitindo REFUND e ROLLBACK sobre a mesma BET uma vez cada, com possível crédito de ambos. As demais ambiguidades continuam propostas até a etapa correspondente. O próximo trabalho será E2, somente quando solicitado.
