# Plano de implementação incremental

Estado: **E0–E13 concluídas**. Fluxos HTTP/SQS, domínio, schema, ledger, idempotência, referências, outbox, reconciliação e observabilidade implementados e verificados. E13 concluiu recuperação global, regressão e documentação reproduzível. Não há tarefa obrigatória pendente ou bloqueada. As decisões e seus mecanismos estão em [ARCHITECTURE.md](ARCHITECTURE.md); os resultados executados estão em [VALIDATION.md](VALIDATION.md).

## Como trabalhar em cada etapa

Antes de iniciar uma etapa, revisar as decisões em aberto que a afetem e explicar o mecanismo que será construído, respeitando as interpretações já autorizadas. Entregar uma fatia pequena, executar suas verificações e apresentar o que foi comprovado e o que continua pendente. A autorização atual abrange E4–E13, em ordem, sem pausas de aprovação entre etapas.

[CHALLENGE.md](CHALLENGE.md) é a cópia integral do enunciado original, sem alterações. Seus números de seção são as referências normativas deste plano. README é o guia de instalação persistente do Bun, execução e validação completa. As evidências E1–E12 abaixo registram o estado histórico de cada entrega; pendências citadas nelas foram resolvidas nas etapas seguintes.

## Etapas e critérios de aceite

| Etapa | Entrega pequena | Critérios de aceite | Requisitos | Verificações |
|---|---|---|---|---|
| E0 — especificação e decisões (concluída) | CHALLENGE, PLAN e ARCHITECTURE | Enunciado preservado byte a byte; propostas, ambiguidades, riscos e mecanismos explícitos; nenhuma dependência ou implementação | §§2–14 | Comparação com README e revisão de rastreabilidade documental |
| E1 — base executável (concluída) | Bun 1.4.4, NestJS, TypeScript estrito, MikroORM, Compose com imagens por digest e três filas FIFO | Build e execução; EM isolado; estrutura de migrations; filas/redrive reproduzíveis; configuração validada; health com timeout; ProviderIdentityPort registrado; README com comandos | §§2, 4, 9–10 | 13 testes de configuração + 9 smoke tests com containers reais; tipos/build; instalação congelada; CLI sem migrations pendentes; readiness 503/liveness 200 com cada dependência parada e pausada |
| E2 — Money (concluída) | Value object imutável e conversor de infraestrutura BIGINT, sem dependências novas | String externa canônica com duas casas; bigint sem limite SQL no domínio; negativos internos; moedas ISO validadas; erro de moeda; driver number rejeitado; limites assinados só na fronteira de persistência | §5, restrição 1; §§6.0–6.1 | U01 e parte Money de U04: 117 testes novos; 13 de configuração preservados; 4 testes PostgreSQL reais em tabela temporária, sem migrations ou tabelas financeiras |
| E3 — modelo de domínio (concluída) | Wallet, WagerTransaction/enums, ledger, inbox, outbox, erros/códigos, quatro eventos e backoff puro | Factories/rehydrate distintos; Wallet aplica movimento com ledger retido; version inicia em 1; terminais protegidos; LOSS sem movimento; reversões integrais por tipo/contexto; eventos JSON imutáveis; tempo/random injetados | §§6–7, 11 | 101 testes novos; 231 unitários ao todo; typecheck/build; U02–U04 no domínio, sem evidência SQL ou distribuída |
| E4 — schema e migrations (concluída) | Tabelas, constraints, índices, triggers e papéis do banco | Up/down/up em banco descartável; SQL direto comprova unicidade, não-negatividade, imutabilidade e vínculo saldo/ledger; opening e version corretos | §§4–6; §7, regras 2–5 | I01 e I02, inclusive falhas no COMMIT e uso do papel da aplicação |
| E5 — abertura e consulta de wallet (concluída) | POST/GET de wallet, abertura financeira e leitura de ledger | Abertura positiva gera OPENING + CREDIT + eventos atomicamente; abertura zero sem ledger; version = 1 em ambos; duplicata é conflito; cursor estável e opaco | §§6.2, 6.4, 9, 11 | U02; I02; páginas sob inserções concorrentes; carteira duplicada em paralelo |
| E6 — primeira operação financeira (concluída) | Use case compartilhável, BET e WIN, lock por wallet e outbox gravada | Dois BETs de 80 sobre 100 dão um sucesso e uma rejeição; HTTP só responde após commit; eventos ainda não são publicados; falha intermediária desfaz todas as escritas | §§5, 7–9, 11 | U03; I02; C02, C03 e C04 |
| E7 — idempotência e consultas de transação (concluída) | Hash canônico, uniques, snapshots do resultado e replay | 50 chamadas paralelas causam um efeito; payload divergente é 409; replay mantém primeira resposta e HTTP, alterando só idempotentReplay; GET expõe evolução e resultado terminal histórico; identidade externa duplicada não cria operação nova | §§6.3, 9; §7, regra 7 | U05; C01; parte de I06/C08; testar primeiro 202 preservado depois de conclusão e reinício; HTTP/SQS usam o mesmo contrato |
| E8 — resultados e reversões (concluída) | LOSS, REFUND, ROLLBACK e códigos de rejeição | Reversão integral valida contexto e tipo; uma reversão processada por referência + tipo, permitindo REFUND e ROLLBACK sobre a mesma BET uma vez cada; rejeição de débito de reversão tem código próprio; LOSS e rejeições sem ledger/version/balance event | §§6.3–6.4, 7 | U03–U04; disputas de reversão em PostgreSQL; comprovar o efeito de REFUND + ROLLBACK conforme decisão confirmada |
| E9 — referências fora de ordem (concluída) | PENDING_REFERENCE e worker agendado persistente | Retry não depende da mensagem original; backoff/TTL sobrevivem a reinício; referência futura desbloqueia operação uma vez; expiração rejeita e grava evento; múltiplos workers revalidam estado sob lock | §§3, 7.1, 11 | C07, I06; relógio controlável; referência ausente, pendente, rejeitada e de outro contexto |
| E10 — entrada SQS (concluída) | Consumidor, inbox, backoff, redrive/DLQ e shutdown | Mesmo use case de HTTP; inbox na mesma transação; DeleteMessage após commit; erro de negócio terminal recebe ack; transitórios voltam; permanentes chegam à DLQ; SIGTERM drena ou libera visibilidade | §§6.5, 10, 12 | I02, I03, I05; C01 também por SQS, C04, C05 |
| E11 — publicação da outbox (concluída) | Publisher com SKIP LOCKED, timeout e retry | Dois publishers dividem trabalho; publicação só lê eventos confirmados; crash antes/depois de SendMessage não perde evento; eventId permanece igual em republicações; evento confirmado deixa de ser elegível | §§6.5, 11 | I04; C06; indisponibilidade/retorno de SQS; consumidor de teste com dedup persistente |
| E12 — reconciliação e observabilidade (concluída) | Reconciliação consistente, logs, métricas e health completos | Saldo calculado inclui OPENING; diferença sinalizada sem reparo automático; logs JSON sem payload financeiro; todas as métricas obrigatórias presentes; live independente e ready verifica DB/SQS | §§9, 12 | Snapshot consistente sob escrita; divergência controlada; health em falhas de DB/SQS; inspeção de logs/métricas |
| E13 — comprovação e apresentação (concluída) | Suíte integrada, ensaios de falha e documentação operacional | Todos os testes obrigatórios passam com infraestrutura real e ≥3 processos; saldo = ledger em todos os cenários financeiros; setup reproduzível; decisões e limitações atualizadas | §§8, 13–14 | U01–U05, I01–I06 e C01–C08; execução final documentada |

E1 não inclui implementação financeira. E6 grava outbox antes de existir publisher: isso permite validar a atomicidade isoladamente. E10 e E11 serão entregas separadas para facilitar a compreensão das janelas de falha.

## Evidências da conclusão de E1

Validação em 08/11/2026, Linux amd64, Bun 1.4.4, Docker Engine 29.6.1 rootless e Compose 5.2.0:

| Comando | Resultado |
|---|---|
| bun install --frozen-lockfile | Resolução congelada aceita, sem mudanças |
| bun run typecheck | Sem erros, incluindo testes |
| bun run build | Compilação ESM concluída |
| bun run test | 13 testes de configuração passaram |
| bun run migration:pending | No pending migrations; nenhuma migration financeira |
| bun run test:smoke | 9 testes passaram com PostgreSQL e LocalStack reais; API compilada |

O smoke confere FIFO/redrive e bootstrap repetido; contextos EM sobrepostos; nenhuma tabela financeira; health saudável; parada/pausa de cada dependência com readiness 503 e liveness 200; recuperação sem reiniciar a API; porta de identidade registrada e não autenticada. Os containers são restaurados e a API de teste é encerrada. Nenhuma verificação E1 ficou bloqueada.

Na conclusão de E1 ainda não haviam sido executados U01–U05, I01–I06 ou C01–C08. E2 acrescenta as evidências abaixo, sem antecipar migrations reversíveis de schema, papéis restritos, mensagens reais para DLQ ou recuperação de operações/outbox.

## Evidências da conclusão de E2

Validação em 08/11/2026 com Bun 1.4.4 e PostgreSQL 17.11 real do Compose:

| Comando | Resultado |
|---|---|
| bun run typecheck | Sem erros, incluindo testes unitários e integração |
| bun run build | Compilação ESM concluída |
| bun run test | 130 testes passaram: 80 Money, 37 conversor e 13 configuração |
| bun run test:money:postgres | 4 testes passaram: round-trip, dois overflows SQL e limpeza/ausência de alteração permanente |

Money está em src/domain/money.ts, sem imports de NestJS/MikroORM. Tem construtor privado, factories from/zero/rehydrate, centavos bigint privados, Object.freeze, operações imutáveis e serialização exata de negativos/zero. Códigos ISO vêm de snapshot local oficial da SIX, não de regex de três letras ou consulta em runtime.

O conversor separado rejeita number e limita leituras/escritas ao intervalo assinado de BIGINT, incluindo o mínimo negativo assimétrico. O domínio permite valores e intermediários além desse intervalo. O teste real faz binds de string em BIGINT e leitura nativa/textual usando o mesmo driver da aplicação, com transação e tabela TEMPORARY ON COMMIT DROP. Confirma SQLSTATE 22003 para ambos os overflows e catálogo permanente intacto.

U01 está coberto nesta etapa; U04 está coberto somente para Money. I01 permanece pendente quanto a migrations, constraints e schema financeiro, apesar da evidência já obtida para o tipo BIGINT. U02/U03/U05, restante de U04, I02–I06 e C01–C08 continuam futuros. Smoke E1 não foi repetido em E2, pois seus componentes não mudaram. Nenhuma verificação solicitada para E2 ficou bloqueada.

README traz instalação oficial persistente do Bun 1.4.4 e comandos completos de E2, sem caminhos temporários de runtime. Essa entrega foi encerrada em E2; as evidências de E3 estão abaixo.

## Evidências da conclusão de E3

Validação em 08/11/2026, Bun 1.4.4, sem IO no domínio:

| Comando | Resultado |
|---|---|
| bun run typecheck | Sem erros, incluindo os novos testes |
| bun run build | Compilação ESM concluída |
| bun run test | 231 testes passaram, zero falhas: 130 anteriores e 101 novos de E3 |

Os testes novos cobrem factories, rehydrate sem efeitos adicionais, datas defensivas, imutabilidade, abertura zero/positiva, saldo/version, correspondência aritmética do ledger, BET/WIN/LOSS e reversões, contexto/moedas, todos os estados terminais, hash divergente, quatro eventos e backoff determinístico. Não usam esperas reais. O teste REFUND + ROLLBACK da mesma BET comprova o efeito literal em memória: saldo inicial 100, BET 10, dois créditos 10, saldo final 110 e version 4.

U02–U04 estão comprovados no domínio. U05 tem apenas o guard de comparação de hash de transação/inbox: JSON canônico, hash de negócio, reserva persistente e replay continuam em E7/E10. A unicidade de wallet/reversão, idempotência, atomicidade e concorrência no PostgreSQL não foram comprovadas: I01–I06 e C01–C08 financeiros seguem pendentes. Reversões anteriores só são reconhecidas se visíveis no agregado ou fornecidas pelo chamador; isso não substitui unique e lock no banco.

Nenhuma dependência, migration, tabela financeira, endpoint, repositório ou worker foi acrescentado. Os testes reais de E1/E2 não foram repetidos, pois os adaptadores não mudaram; não há verificação E3 bloqueada. CHALLENGE preservado com SHA-256 `47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e`. Trabalho encerrado em E3.

## Catálogo de testes obrigatórios

Os identificadores abaixo são referências deste plano, não nomes prescritos pelo enunciado.

### Unidade — §13

| ID | Cobertura e evidência esperada | Primeira etapa |
|---|---|---|
| U01 | Money: soma, subtração, negação, comparação, igualdade, zero, imutabilidade, formato/escala, limites e round-trip. Mais de duas casas é rejeitado, sem arredondamento silencioso; testar explicitamente esse comportamento | E2 |
| U02 | Wallet: factories/reidratação, saldo não negativo, crédito/débito, version somente com mudança, opening com version 1, produção coerente de ledger | E3, E5 |
| U03 | BET, WIN, LOSS, REFUND, ROLLBACK: efeito, direção, montante igual, contexto da referência, tipos permitidos, duplicidade de reversão e rejeição específica de reversão sem saldo; estados terminais | E3, E8 |
| U04 | Conflitos de moeda nas operações de Money, wallet e referências, ainda que a configuração da aplicação aceite apenas BRL | E2–E3, E8 |
| U05 | Mesmo payload em ordem diferente de chaves gera mesmo hash; alteração de campo de negócio muda hash; mesma key divergente conflita; replay não calcula saldo atual; diferenças de transporte não mudam hash de negócio | E7 |

### Integração — PostgreSQL e LocalStack reais, §13

| ID | Cobertura e evidência esperada | Primeira etapa |
|---|---|---|
| I01 | Migrations reversíveis em base descartável, tipos exatos, uniques, checks, FKs, índices, triggers. Tentar UPDATE/DELETE/TRUNCATE do ledger e mudança de resultado terminal; impedir saldo sem ledger e ledger sem mudança correspondente, inclusive por SQL direto | E4 |
| I02 | Injetar falhas após cada escrita e antes do commit: transação, saldo, ledger, inbox, snapshots e outbox voltam juntos. Confirmar commit completo, inclusive eventos de rejeição, pending e abertura. Erro deferred no COMMIT também não permite ack/resposta de sucesso | E4–E6, E10 |
| I03 | Inbox `(consumerName, messageId)`, redelivery com mesmo e outro envelope, colisão de messageId com payload diferente, mesma operação por HTTP + SQS, nova mensagem para transação já existente; nenhum efeito adicional | E10 |
| I04 | Dois publishers concorrentes, seleção por vencimento, retries, eventId estável e retomada após crash; testar também duplicação após envio antes da marcação, sem confiar na janela de dedup do FIFO | E11 |
| I05 | Retry transitório com backoff, maxReceiveCount e DLQ; envelope inválido/permanente; SQS e PostgreSQL indisponíveis e recuperados; parada graciosa e falha ao deletar mensagem após commit | E10–E11 |
| I06 | Reiniciar processos preservando volumes; retomar pendências/outbox; redelivery/replay usam estado persistido; reference TTL/backoff e resultado histórico sobrevivem | E7, E9–E11 |

### Concorrência real — itens 1–8 da §13

| ID | Cenário obrigatório e critério observável | Etapa |
|---|---|---|
| C01 | Mesma BET 50 vezes em paralelo: uma transação, um débito, um conjunto de eventos financeiros; demais respostas são replay. Cobrir HTTP e redelivery fora da dedup do broker | E7, E10 |
| C02 | Saldo 100.00 e duas BETs de 80.00: uma PROCESSED, outra REJECTED por saldo insuficiente, saldo 20.00, um débito; retry não debita de novo | E6 |
| C03 | Wallets distintas: usar barreiras para comprovar sobreposição de trabalho com locks diferentes; nenhuma dependência de lock global. Evitar depender apenas de medição frágil de tempo | E6 |
| C04 | ≥3 processos com conexões/EntityManagers próprios disputando o mesmo banco. Exercitar HTTP, consumidores e workers; Promise.all em um processo isolado não substitui este cenário | E6, E10–E13 |
| C05 | Matar consumidor em barreira depois do commit e antes de DeleteMessage; outra instância recebe novamente, consulta inbox e não repete saldo/ledger/eventos | E10 |
| C06 | Dois publishers sobre a mesma outbox, com trabalho simultâneo e crash controlado. Todos os eventos confirmados chegam; duplicatas têm mesmo eventId e efeito único no consumidor de teste | E11 |
| C07 | Entregar REFUND e ROLLBACK antes da referência; commit de PENDING_REFERENCE sem ledger, ack quando via SQS, reprocessamento agendado após chegada da referência, um efeito por operação | E9–E10 |
| C08 | Reiniciar o serviço durante carga limitada e filas pendentes; retomar sem apagar volumes e comprovar consistência final, resultados persistidos e outbox sem eventos abandonados | E13 |

Em todos os cenários com wallets, verificar ao final, por wallet e moeda: `balance = SUM(CREDIT) - SUM(DEBIT)`, incluindo OPENING, com soma exata. Acrescentar checks de contagem de ledger, estados, versões e eventos esperados: a igualdade isolada pode esconder dois efeitos indevidos que se anulem.

Usar barreiras/pontos de falha habilitados apenas nos testes para produzir interleavings e crashes de forma verificável. Separar processos e conexões; não usar mocks sequenciais como evidência de concorrência. Limitar esperas e registrar seeds quando houver jitter. Testes de mecanismos financeiros devem usar o mesmo papel de banco da aplicação.

## Decisões confirmadas e interpretações adotadas

1. **Confirmada e implementada em E2:** Money usa bigint em centavos; conversor exato BIGINT. Entrada externa canônica não negativa, negativos internos e limites de persistência separados do domínio (A04 confirmada nesta solicitação).
2. **Confirmada:** replay retorna a primeira resposta persistida e seu status HTTP, alterando somente idempotentReplay. GET expõe evolução atual e resultado terminal histórico, quando disponível (A01).
3. **Confirmada:** reversão única por referência + tipo; REFUND e ROLLBACK podem atingir a mesma BET uma vez cada, produzindo potencialmente dois créditos (A02).
4. **Adotadas em E3/E7/E8:** valores zero (A03), WIN com referência opcional, BET/LOSS sem referência, validação de referências não processadas, sem exigir mesmo gameId (A06–A07), OPENING interno sem identidade externa (A11). Key global literal; nova key para mesma identidade externa conflita (A05/A06). Nenhuma regra adicional de rodada.
5. **Adotadas em E9–E12:** TTL de referência 24h e backoff configurável; eventos em wager-events.fifo; erros de envelope vão à DLQ sem transação artificial; limites BIGINT, sem limpeza automática de histórico (A08–A12). São escolhas justificadas do desenho, não obrigações adicionais do desafio.

ARCHITECTURE registra as interpretações finais e sua justificativa. A autorização atual abrange todas as etapas restantes até E13.

## Limites de escopo e conclusão

Autenticação fica adiada; ProviderIdentityPort e adaptador de desenvolvimento já estão registrados em E1. Não incluir IdP, usuários/senhas próprios, double-entry, event sourcing, barramento genérico, OpenTelemetry, dashboard ou teste de carga no caminho obrigatório. Não criar cadastro de provedores, fechamento de rodada ou regras de settlement ausentes no enunciado.

O desafio só estará concluído após E13. Documentar um mecanismo, criar uma constraint ou executar um teste unitário não comprova isoladamente a correção distribuída. No fechamento, registrar versões efetivas, comandos, ambiente, resultados, limites e riscos remanescentes. Carga é opcional; se adicionada depois, seguir o comando e a metodologia da §14.

## Evidências E4 e retomada

E4 concluída em 08/11/2026: `bun run typecheck`, `bun run build`, 231 testes unitários e 22 testes reais de schema passaram. Comando reproduzível: `bun run test:schema` (Compose PostgreSQL saudável). A suíte cria um banco `challenge_test_*` exclusivo e o remove; aplica up/down/up, usa papel runtime não administrativo e prova constraints, guards, falha diferida no COMMIT, reversão por tipo e rollback após cada uma das cinco escritas. As garantias distribuídas e o fluxo da aplicação ainda não estão provados. Próxima tarefa: E5, abertura/consultas de wallet e paginação. Autorização vigente: avançar até E13 sem revisão intermediária.

## Evidências E5

E5 concluída: tipos/build e 232 unitários passaram; `bun run test:wallets` executa 17 testes de API compilada + PostgreSQL real. Prova abertura positiva/zero, round-trip ORM acima de MAX_SAFE_INTEGER, dez aberturas concorrentes (1 sucesso/9 conflitos), entradas/overflow, consultas, cursor estável sob inserção e rollback após wallet/transação/ledger/outbox. O custom type ExactBigIntType reutiliza a conversão E2, rejeitando number do driver. Session/EntityManager é novo por transação; mapeamentos ficam em infraestrutura. Nenhum evento é publicado ainda. Próxima etapa: E6, BET/WIN com lock por wallet e testes em três processos.

## Evidências E6

E6 concluída: tipos/build, 232 unitários e `bun run test:concurrency` (10 integrações) passaram. A suíte inicia três processos da API compilada com PIDs/conexões próprios; comprova duas BETs de 80 sobre 100, três disputantes, WIN, rejeições por moeda/player/limite, rollback após cada escrita e falha diferida no COMMIT. Wallet distinta conclui enquanto outra fica bloqueada, observado em pg_blocking_pids. Todas as wallets testadas são reconciliadas exatamente pelo ledger. O use case já grava hash/snapshots e faz replay básico como pré-requisito de processamento seguro; E7 completa consultas e os ensaios de identidade/replay/reinício. Outbox só é persistida, sem publicação. Próxima tarefa: E7.

## Evidências E7

E7 concluída: tipos/build, 241 unitários e `bun run test:idempotency` (7 integrações) passaram. Cinquenta BETs idênticas em três APIs geram um débito, uma transação e dois eventos; key divergente, identidade externa com outra key e colisões entre wallets dão conflito sem efeito adicional. GET interno/por provedor expõe estado atual, acceptanceResult e terminalResult históricos com HTTP. Replay preserva primeiro corpo/HTTP e só muda idempotentReplay, inclusive depois de outros créditos e reinício. O teste 202->terminal usa evolução SQL controlada para isolar a proteção do snapshot; o worker real e seus eventos serão comprovados em E9. A05 adotada: key global literal; prefixo provider:externalId sugerido, não obrigatório. Próxima tarefa: E8.

## Evidências E8

E8 concluída: tipos/build, 241 unitários e `bun run test:reversals` (8 integrações) passaram. LOSS zero/positivo gera só Processed, sem ledger/version/evento de saldo. REFUND + ROLLBACK da mesma BET confirmam dois créditos; três REFUNDs por três processos confirmam um crédito/duas rejeições. ROLLBACK de WIN/REFUND debita; insuficiência tem código próprio e não consome reversão futura com outra identidade. Contexto, moeda, montante, tipo, autorreferência, referências terminais, OPENING externo e referência obrigatória foram verificados. Todas as wallets financeiras foram reconciliadas. Próxima tarefa: E9, agendamento persistente e recuperação de referências.

## Evidências E9

E9 concluída: tipos/build, 241 unitários, cinco testes reais de referências e regressão integrada E2–E9 (74 testes) passaram. Três workers concorrentes retomam REFUND/ROLLBACK antes da BET; reinício da API/workers preserva pendências e primeiro 202, agora com evolução real pelo worker e eventos terminais. Relógio/random injetados verificam backoff, contagem só após commit, expiração NOT_FOUND/NOT_READY e referência válida prevalecendo após TTL. Nenhuma espera real é usada nos testes de cálculo. A regressão revelou e corrigiu uma corrida do atalho de identidade externa; um teste com barreira real fixa commit entre lookup rápido e lock e exige replay. A08 adotada: TTL 24h, janela 5s até 5min, configuráveis. Próxima tarefa: E10, inbox/consumidor SQS, retry/DLQ, crash e shutdown.

## Evidências E10

E10 concluída: tipos/build, 241 unitários e `bun run test:commands` (20 integrações reais) passaram. Mesma operação em 25 HTTP + 25 envelopes SQS por três consumidores causa um efeito; inbox deduplica messageId/hash e conflitos vão à DLQ após cinco recebimentos. Rejeição e PENDING_REFERENCE confirmam inbox e recebem ack. REFUND/ROLLBACK SQS fora de ordem são retomados sem a mensagem. Crashes via barreira IPC antes do COMMIT e depois dele/antes do ack produzem redelivery sem duplicar efeito. Sete falhas (inbox, transação, wallet, ledger, outbox, conclusão e COMMIT diferido) revertem tudo e não dão ack. PostgreSQL foi parado/reiniciado com recuperação; LocalStack pausado causou falha real de ack, sem alterar o resultado confirmado. SIGTERM devolve visibilidade durante trabalho bloqueado e encerra com consistência. Filas de testes têm prefixo exclusivo e são removidas; recursos normais não são purgados. Próxima tarefa: E11, publisher concorrente e comprovação do outbox.

## Evidências E11

E11 concluída: tipos/build, 241 unitários e `bun run test:publisher` (5 integrações) passaram. Publisher não vê escrita não confirmada; segundo publisher usa SKIP LOCKED e conclui nove linhas enquanto a primeira está bloqueada. Crashes before_send/after_send retomam eventos com mesmo eventId. Indisponibilidade SQS persiste attempts/nextAttemptAt, sem alterar envelopes. Consumidor de teste usa a inbox real e tabela de efeitos sem unique em eventId: duas entregas do mesmo evento causam um efeito. Para não depender dos cinco minutos FIFO, a duplicata real usa dedup ID de transporte novo, preservando eventId/payload. Não se afirma exatamente uma entrega; o transporte é ao menos uma vez. Próxima tarefa: E12, reconciliação/logs/métricas.

## Evidências E12

E12 concluída: tipos/build, 241 unitários e `bun run test:observability` (8 integrações) passaram. Reconciliação read-only REPEATABLE READ permanece coerente quando BET confirma entre leitura de saldo e SUM; divergência administrativa controlada é sinalizada sem reparo, logada e contada (fixture restaura sua corrupção). Logs JSON não têm payload/valores financeiros ou autorização. Métricas Prometheus cobrem estados, duplicatas, latência, retry, DLQ, locks e outbox; IDs não são labels. Cada worker expõe endpoint próprio. SQLSTATE40001 real após escrita exige EM novo e confirma um efeito; esgotamento após três tentativas reverte tudo. Próxima tarefa: E13, reinício do sistema completo, regressão final, guias e evidências consolidadas.

## Evidências E13 e fechamento

E13 concluída em 08/11/2026. `bun run verify` final iniciou em **2026-11-08T20:06:02.714Z**: instalação congelada, infraestrutura, build, setup/migrations e typecheck passaram; **241 unitários + 109 integrações + 9 smoke = 359 testes**, zero falhas. CLI confirmou ausência de migrations pendentes. Logs e durações estão em [VALIDATION.md](VALIDATION.md), gerado pelo script versionado; logs completos locais em `artifacts/validation/2026-11-08T20-06-02.713Z/`.

O ensaio `system-recovery.test.ts` substituiu três APIs e três workers com funções combinadas. PIDs iniciais: `275346,275353,275354,275443,275444,275445`; PIDs novos: `275841,275842,275843,275907,275908,275909`. Com referências, fila e outbox pendentes, matou as APIs com SIGKILL, reiniciou PostgreSQL preservando volume e iniciou seis processos novos. Verificou nove transações (oito processadas/uma rejeitada), sete lançamentos, saldo/ledger **35.00 BRL**, version 7, 19 inboxes concluídas e os 18 eventIds da outbox recebidos no SQS. Replay preservou saldo/status HTTP originais, inclusive primeiro 202 após conclusão real. Workers nesse ensaio foram drenados antes da interrupção; crashes de consumidor em andamento estão comprovados separadamente em E10.

A regressão final também repetiu as barreiras de saldo, identidades, COMMIT, ack, envio e SKIP LOCKED; DLQ/retry reais; SQL adversarial; snapshots históricos; reconciliação e detecção de divergência. O smoke encontrou e levou à correção do filtro global que sanitizava o corpo do readiness 503: agora o controller retorna seu contrato operacional com checks e status corretos. Nove smoke tests passaram após a correção, incluindo parada e pausa de cada dependência, liveness e recuperação sem reiniciar a API. Snapshots automáticos de migration foram desativados na fixture; testes não deixam esses arquivos no projeto.

| Requisito obrigatório | Evidência final reproduzível |
|---|---|
| U01–U05 | `bun run test`: 241 testes de Money, domínio, moedas, invariantes e hash |
| I01 | `test:schema` e `test:money:postgres`: 26 testes, migration up/down/up, papel restrito e BIGINT real |
| I02 | `test:wallets`, `test:concurrency`, `test:commands`: falhas após escritas e no COMMIT revertem a unidade |
| I03 / C01 / C05 | `test:idempotency`, `test:commands`: 50 cópias HTTP/HTTP+SQS, inbox, redelivery, SIGKILL pós-COMMIT/pré-ack |
| I04 / C06 | `test:publisher`: dois publishers, SKIP LOCKED, crashes e dedup persistente de eventos |
| I05 | `test:commands`, `test:publisher`, `test:smoke`: retry, DLQ, ack falho, interrupções e shutdown |
| I06 / C07 / C08 | `test:references`, `test:commands`, `test:recovery`: fora de ordem, restart, backlog e histórico |
| C02 / C03 / C04 | `test:concurrency`: três APIs reais, disputa 80/100 e wallet distinta avançando sob barreira |
| Observabilidade/reconciliação | `test:observability`: snapshot REPEATABLE READ, divergência sem reparo, logs/métricas |

README documenta instalação persistente do Bun, setup, API/workers, comandos e limites. ARCHITECTURE descreve mecanismos reais e taxonomia; STUDY orienta leitura/demonstração. CHALLENGE e bun.lock preservados. Nenhum requisito obrigatório ficou bloqueado. Limites declarados: autenticação adiada, entrega de eventos ao menos uma vez, sem ordem cronológica extra entre publishers, LocalStack sem durabilidade alegada após reiniciar seu container, hot wallets serializadas e métricas locais voláteis. Esses limites não são apresentados como garantias comprovadas.

Escopo autorizado concluído. Nenhum deploy, push ou diferencial opcional foi executado. Para revalidar, preparar `.env` como no README e executar `bun run verify`; não rodar outras suítes nos mesmos serviços durante ensaios de falha.
