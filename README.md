# Distributed Wagering Processor

Serviço financeiro com Bun, NestJS, MikroORM, PostgreSQL e SQS via LocalStack. Implementa abertura de wallet, BET/WIN/LOSS/REFUND/ROLLBACK, ledger imutável, idempotência persistente, referências fora de ordem, inbox, outbox, reconciliação e observabilidade. **E0–E13 concluídas**: 241 testes unitários, 109 integrações e nove smoke passaram; resultados em [VALIDATION.md](VALIDATION.md).

O enunciado integral permanece em [CHALLENGE.md](CHALLENGE.md). [PLAN.md](PLAN.md) liga etapas a requisitos e testes; [ARCHITECTURE.md](ARCHITECTURE.md) explica mecanismos e decisões; [STUDY.md](STUDY.md) traz um roteiro para apresentação.

## Preparar do zero

Pré-requisitos: Docker Engine/Compose com suporte a `up --wait` e Bun **1.4.4**. API e workers executam no host; PostgreSQL e LocalStack no Compose. AWS CLI no host não é necessária.

Instalação persistente do [Bun oficial com versão específica](https://bun.com/docs/installation#installing-older-versions), em Linux/macOS (curl/unzip necessários):

```sh
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.4"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Mantenha esse PATH no perfil do shell. O binário fica em `$HOME/.bun/bin`; nenhum comando depende de instalação temporária. Na raiz do projeto:

```sh
test -f .env || cp .env.example .env
bun install --frozen-lockfile
bun run infra:up
bun run db:setup
bun run start
```

`db:setup` compila, cria o papel runtime se ausente, aplica migrations e concede acessos. Não faz schema sync ou limpa dados. Para `.env` de E1/E2, use `PGUSER=wagering_app` e `PG_MIGRATION_USER=wagering`. As senhas locais de exemplo são `local-development-only`. O setup preserva a senha de um papel existente: mudar a senha apenas no arquivo não altera a senha no PostgreSQL.

Os valores de `.env.example` são fictícios e locais; `.env` é ignorado pelo Git. Bun carrega o arquivo automaticamente. Configuração inválida mostra nomes dos campos, sem seus valores.

Em outro terminal, inicie os workers:

```sh
bun run workers
```

Por padrão, um processo executa `references,commands,publisher`. Para separar funções ou escalar, abra outros terminais:

```sh
WORKER_ROLES=commands WORKER_METRICS_PORT=9101 bun run workers
WORKER_ROLES=references WORKER_METRICS_PORT=9102 bun run workers
WORKER_ROLES=publisher WORKER_METRICS_PORT=9103 bun run workers
```

Você também pode executar três processos com todas as funções, usando portas de métricas distintas. Sem porta explícita, `WORKER_METRICS_PORT=0` escolhe uma livre e registra `metricsPort` no log `workers_started`. Ctrl+C/SIGTERM interrompe novas leituras e drena/devolve trabalho; o prazo final de encerramento é 20s.

Defaults: API `127.0.0.1:3000`, PostgreSQL `127.0.0.1:5432`, LocalStack `127.0.0.1:4566`. Ajuste as portas em `.env`; SQS_ENDPOINT precisa corresponder a LOCALSTACK_PORT. `bun run start:dev` oferece recarga de TypeScript; workers usam o build compilado.

## Verificar tudo

Com `.env` preparado:

```sh
bun run verify
```

O comando verifica lockfile congelado, infraestrutura, build, setup do banco, tipos, unidade, integração, smoke e migrations pendentes. Atualiza `VALIDATION.md` e grava logs por etapa em `artifacts/validation/` (ignorado no Git). O relatório é atualizado a cada etapa, inclusive em falha, para permitir retomada.

Os testes usam PostgreSQL e LocalStack reais. Cada suíte financeira cria/remove seu próprio banco `challenge_test_*`; testes de SQS criam/remove filas com prefixo exclusivo. Não limpam wallets ou filas normais. Suítes destrutivas exigem endpoints locais. Os ensaios de falha param/pausam **somente** serviços deste Compose e restauram-nos em `finally`; execute-os sem outras suítes nesses mesmos serviços em paralelo.

Comandos individuais (scripts de integração incluem build):

| Comando | Cobertura |
|---|---|
| `bun run typecheck` / `bun run build` | TypeScript estrito / ESM compilado |
| `bun run test` | Money, domínio, conversor, contratos/hash e configuração |
| `bun run test:money:postgres` | BIGINT real em tabela temporária, sem migration artificial |
| `bun run test:schema` | Up/down/up, constraints, triggers e papel restrito |
| `bun run test:wallets` | Abertura, consultas, paginação, rollback |
| `bun run test:concurrency` | Três APIs, disputa de saldo e locks independentes |
| `bun run test:idempotency` | 50 duplicatas, colisões, replay, snapshots e reinício |
| `bun run test:reversals` | LOSS, REFUND, ROLLBACK, concorrência e moedas |
| `bun run test:references` | Três workers, TTL/backoff e recuperação |
| `bun run test:commands` | Inbox, retry/DLQ, crashes, indisponibilidade e shutdown |
| `bun run test:publisher` | Dois publishers, SKIP LOCKED, crash e duplicação de eventos |
| `bun run test:observability` | Snapshot, divergência, logs e métricas reais |
| `bun run test:recovery` | Três APIs + três workers, reinício global e backlog |
| `bun run test:integration` | Todas as integrações, em sequência |
| `bun run test:smoke` | Health, filas, EM isolado, parada/pausa e recuperação |

## API

Autenticação está adiada. `ProviderIdentityPort` é usado no ingresso HTTP financeiro, com adaptador de desenvolvimento que declara `authenticated: false`. Health é aberto; SQS é canal interno confiável, mantendo as validações de domínio.

| Método/rota | Comportamento |
|---|---|
| POST `/wallets` | Abre wallet; 201, ou 409 para mesmo player/moeda |
| GET `/wallets/:walletId` | Saldo/version atuais |
| GET `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger em ordem de versão, corte estável; limit 1–100 |
| POST `/wagering/transactions` | `Idempotency-Key` obrigatório; mesmo caso de uso do SQS |
| GET `/wagering/transactions/:transactionId` | Estado atual e resultados históricos |
| GET `/providers/:providerId/wagering/transactions/:externalId` | Mesma consulta por identidade externa |
| POST `/wallets/:walletId/reconciliation` | Snapshot consistente; divergência retorna 200 com consistent=false |
| GET `/health/live` | 200, sem dependências |
| GET `/health/ready` | 200 ou 503; PostgreSQL e três filas com deadline |
| GET `/metrics` | Prometheus: métricas locais + gauges de DB/SQS |

Exemplo de abertura (troque playerId ao repetir o exemplo):

```sh
curl -sS http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"demo-player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Copie o `id` retornado para WALLET_ID:

```sh
WALLET_ID='id-retornado'
curl -sS http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-demo:bet-1' \
  -H 'X-Correlation-Id: interview-demo' \
  --data-binary @- <<JSON
{"providerId":"provider-demo","externalTransactionId":"bet-1","playerId":"demo-player-1","walletId":"${WALLET_ID}","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}
JSON
```

Repita exatamente a chamada: retorna o mesmo transactionId/saldo/status HTTP, mudando somente `idempotentReplay` no corpo. A key é literal e global; o prefixo provider:externalId é sugerido. Mesma key com outro payload é 409; mesma identidade externa com outra key também é 409, com código distinto.

Estados: 200 PROCESSED, 422 REJECTED com failureCode, 202 PENDING_REFERENCE. Payload/contrato inválido é 400; recurso ausente 404; indisponibilidade transitória 503. Rejeição/falha de transporte não fabricam movimento. GET retorna `acceptanceResult` e `terminalResult` com `httpStatus/body`; um primeiro 202 continua 202 no replay depois da conclusão. X-Correlation-Id é metadado de transporte.

```sh
curl -sS "http://127.0.0.1:3000/wallets/$WALLET_ID/ledger?limit=50"
curl -sS -X POST "http://127.0.0.1:3000/wallets/$WALLET_ID/reconciliation"
curl -sS http://127.0.0.1:3000/health/live
curl -sS http://127.0.0.1:3000/health/ready
curl -sS http://127.0.0.1:3000/metrics
```

## Filas e recuperação

O hook convergente do LocalStack cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. Comandos têm visibility timeout 30s e redrive `maxReceiveCount=5`. Para conferir/reexecutar:

```sh
bun run infra:queues
docker compose exec -T localstack awslocal sqs list-queues
```

O envelope de entrada está em CHALLENGE §10; `data.idempotencyKey` é obrigatório. Dedup lógico da inbox usa `(consumerName, messageId)` do envelope e hash canônico; receipt/atributos do broker não entram no hash. Ack só após commit. Envelope inválido vai à DLQ por redrive, sem entidade artificial. Referência pendente recebe ack: o agendamento já está no PostgreSQL.

Referências: TTL 24h, janela exponencial 5s a 5min com equal jitter, configuráveis. Ausência e referência ainda pendente expiram com códigos distintos. Referência válida encontrada na retomada prevalece sobre o TTL. Outbox: janela 1s a 60s, sem descarte automático. Publicação é ao menos uma vez; consumidores de eventos precisam deduplicar persistentemente por eventId.

## Versões e migrations

| Componente | Versão fixa |
|---|---|
| Bun / @types/bun | 1.4.4 |
| TypeScript | 6.0.3, strict |
| NestJS | 12.4.0 |
| MikroORM / CLI / migrations / PostgreSQL driver | 7.2.8 |
| Integração MikroORM/NestJS | 7.1.0 |
| AWS SDK SQS | 3.1164.0 |
| PostgreSQL | 17.11-alpine, digest no Compose |
| LocalStack Community | 4.14.0, digest no Compose |

Dependências diretas exatas, `bun.lock` e imagens por digest tornam a resolução reproduzível. A compatibilidade foi verificada em fontes oficiais e em execução real. LocalStack está fixado nessa edição comunitária por permitir SQS local sem token; não é uma recomendação de versão atual para produção.

```sh
bun run migration:pending
bun run migration:up
```

Migrations usam PG_MIGRATION_USER/PASSWORD; API/workers usam PGUSER/PGPASSWORD restritos. `migration:down` é destrutiva: a validação up/down/up roda em banco descartável próprio. Não há schema sync automático.

## Decisões e limites

Money usa bigint em centavos; entrada externa canônica não negativa com duas casas, sem arredondamento ou câmbio. O domínio permite negativos/intermediários maiores; a persistência limita BIGINT e rejeita number do driver. Version inicia em 1 e só aumenta quando o saldo muda. LOSS não move saldo nem gera ledger. REFUND e ROLLBACK podem atingir a mesma BET uma vez cada: abertura 100, BET 10 e ambos os créditos 10 resultam em 110, conforme interpretação confirmada.

Lock por linha serializa hot wallets; publisher ocupa conexão enquanto chama SQS com timeout. Não há promessa de exactly-once no transporte ou ordem cronológica de saída entre publishers. Métricas locais reiniciam com o processo; gauges de DB/SQS são compartilhados e não devem ser somados entre instâncias. O papel administrativo pode alterar DDL; as proteções são exercitadas com o papel runtime.

PostgreSQL persiste em volume nomeado. LocalStack recria filas, sem garantia de preservar mensagens ao reiniciar seu container; o ensaio global reinicia aplicações/PostgreSQL mantendo o broker, e a indisponibilidade SQS é testada também por pausa. Autenticação, double-entry, event sourcing, dashboard, tracing e carga não foram acrescentados. Não há fechamento de rodada ou exclusão WIN/LOSS.

Para parar preservando o volume PostgreSQL:

```sh
bun run infra:down
```
