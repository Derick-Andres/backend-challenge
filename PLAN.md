# Plano de implementação incremental

Estado: **E0 e E1 concluídas; E2–E13 pendentes**. A base foi implementada e validada; não há implementação financeira. As escolhas confirmadas e as propostas futuras estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Como trabalhar em cada etapa

Antes de iniciar uma etapa, revisar com o usuário as decisões em aberto que a afetem e explicar o mecanismo que será construído. Entregar uma fatia pequena, executar suas verificações e apresentar o que foi comprovado e o que continua pendente. A autorização atual termina em E1; não avançar para E2.

[CHALLENGE.md](CHALLENGE.md) é a cópia integral do enunciado original, sem alterações. Seus números de seção são as referências normativas deste plano. README agora é o guia de execução da base E1; o enunciado continua preservado em CHALLENGE.md.

## Etapas e critérios de aceite

| Etapa | Entrega pequena | Critérios de aceite | Requisitos | Verificações |
|---|---|---|---|---|
| E0 — especificação e decisões | CHALLENGE, PLAN e ARCHITECTURE | Enunciado preservado byte a byte; propostas, ambiguidades, riscos e mecanismos explícitos; nenhuma dependência ou implementação | §§2–14 | Comparação com README e revisão de rastreabilidade documental |
| E1 — base executável (concluída) | Bun 1.4.4, NestJS, TypeScript estrito, MikroORM, Compose com imagens por digest e três filas FIFO | Build e execução; EM isolado; estrutura de migrations; filas/redrive reproduzíveis; configuração validada; health com timeout; ProviderIdentityPort registrado; README com comandos | §§2, 4, 9–10 | 13 testes de configuração + 9 smoke tests com containers reais; tipos/build; instalação congelada; CLI sem migrations pendentes; readiness 503/liveness 200 com cada dependência parada e pausada |
| E2 — Money | Value object imutável e conversor exato de persistência | Strings com duas casas; nenhuma conversão monetária para number; erro para moeda diferente, formato inválido e excesso de capacidade; serialização exata inclusive acima de MAX_SAFE_INTEGER | §5, restrição 1; §§6.0–6.1 | U01, U04; round-trip de conversão com PostgreSQL em I01 |
| E3 — modelo de domínio | Wallet, WagerTransaction, Ledger, Inbox, Outbox e eventos concretos | Factories e rehydrate distintos; transições terminais protegidas; regras financeiras encapsuladas; LOSS sem saldo/ledger; eventos com envelope versionado | §§6–7, 11 | U02–U04; decisões A02–A07 da arquitetura revisadas |
| E4 — schema e migrations | Tabelas, constraints, índices, triggers e papéis do banco | Up/down/up em banco descartável; SQL direto comprova unicidade, não-negatividade, imutabilidade e vínculo saldo/ledger; opening e version corretos | §§4–6; §7, regras 2–5 | I01 e I02, inclusive falhas no COMMIT e uso do papel da aplicação |
| E5 — abertura e consulta de wallet | POST/GET de wallet, abertura financeira e leitura de ledger | Abertura positiva gera OPENING + CREDIT + eventos atomicamente; abertura zero sem ledger; version = 1 em ambos; duplicata é conflito; cursor estável e opaco | §§6.2, 6.4, 9, 11 | U02; I02; páginas sob inserções concorrentes; carteira duplicada em paralelo |
| E6 — primeira operação financeira | Use case compartilhável, BET e WIN, lock por wallet e outbox gravada | Dois BETs de 80 sobre 100 dão um sucesso e uma rejeição; HTTP só responde após commit; eventos ainda não são publicados; falha intermediária desfaz todas as escritas | §§5, 7–9, 11 | U03; I02; C02, C03 e C04 |
| E7 — idempotência e consultas de transação | Hash canônico, uniques, snapshots do resultado e replay | 50 chamadas paralelas causam um efeito; payload divergente é 409; replay mantém primeira resposta e HTTP, alterando só idempotentReplay; GET expõe evolução e resultado terminal histórico; identidade externa duplicada não cria operação nova | §§6.3, 9; §7, regra 7 | U05; C01; parte de I06/C08; testar primeiro 202 preservado depois de conclusão e reinício; HTTP/SQS usam o mesmo contrato |
| E8 — resultados e reversões | LOSS, REFUND, ROLLBACK e códigos de rejeição | Reversão integral valida contexto e tipo; uma reversão processada por referência + tipo, permitindo REFUND e ROLLBACK sobre a mesma BET uma vez cada; rejeição de débito de reversão tem código próprio; LOSS e rejeições sem ledger/version/balance event | §§6.3–6.4, 7 | U03–U04; disputas de reversão em PostgreSQL; comprovar o efeito de REFUND + ROLLBACK conforme decisão confirmada |
| E9 — referências fora de ordem | PENDING_REFERENCE e worker agendado persistente | Retry não depende da mensagem original; backoff/TTL sobrevivem a reinício; referência futura desbloqueia operação uma vez; expiração rejeita e grava evento; múltiplos workers revalidam estado sob lock | §§3, 7.1, 11 | C07, I06; relógio controlável; referência ausente, pendente, rejeitada e de outro contexto |
| E10 — entrada SQS | Consumidor, inbox, backoff, redrive/DLQ e shutdown | Mesmo use case de HTTP; inbox na mesma transação; DeleteMessage após commit; erro de negócio terminal recebe ack; transitórios voltam; permanentes chegam à DLQ; SIGTERM drena ou libera visibilidade | §§6.5, 10, 12 | I02, I03, I05; C01 também por SQS, C04, C05 |
| E11 — publicação da outbox | Publisher com SKIP LOCKED, timeout e retry | Dois publishers dividem trabalho; publicação só lê eventos confirmados; crash antes/depois de SendMessage não perde evento; eventId permanece igual em republicações; evento confirmado deixa de ser elegível | §§6.5, 11 | I04; C06; indisponibilidade/retorno de SQS; consumidor de teste com dedup persistente |
| E12 — reconciliação e observabilidade | Reconciliação consistente, logs, métricas e health completos | Saldo calculado inclui OPENING; diferença sinalizada sem reparo automático; logs JSON sem payload financeiro; todas as métricas obrigatórias presentes; live independente e ready verifica DB/SQS | §§9, 12 | Snapshot consistente sob escrita; divergência controlada; health em falhas de DB/SQS; inspeção de logs/métricas |
| E13 — comprovação e apresentação | Suíte integrada, ensaios de falha e documentação operacional | Todos os testes obrigatórios passam com infraestrutura real e ≥3 processos; saldo = ledger em todos os cenários financeiros; setup reproduzível; decisões e limitações atualizadas | §§8, 13–14 | U01–U05, I01–I06 e C01–C08; execução final documentada |

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

O smoke confere FIFO/redrive e bootstrap repetido; contextos EM sobrepostos; nenhuma tabela financeira; health saudável; parada/pausa de cada dependência com readiness 503 e liveness 200; recuperação sem reiniciar a API; porta de identidade registrada e não autenticada. Os containers são restaurados e a API de teste é encerrada. Nenhuma verificação E1 ficou bloqueada. Instalação local do Bun nesta sessão ocorreu em /tmp, sem alterar instalação global.

Não foram executados testes financeiros U01–U05, I01–I06 ou C01–C08: continuam critérios futuros. Migrations reversíveis de schema, papéis restritos, mensagens reais encaminhadas para DLQ e recuperação de operações/outbox permanecem fora de E1.

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

## Decisões confirmadas e propostas futuras

1. **Confirmada:** Money usará bigint em centavos e BIGINT no PostgreSQL; implementação apenas em E2.
2. **Confirmada:** replay retorna a primeira resposta persistida e seu status HTTP, alterando somente idempotentReplay. GET expõe evolução atual e resultado terminal histórico, quando disponível (A01).
3. **Confirmada:** reversão única por referência + tipo; REFUND e ROLLBACK podem atingir a mesma BET uma vez cada, produzindo potencialmente dois créditos (A02).
4. **Propostas futuras:** valores zero, escopo da key, identidade externa e referências opcionais (A03–A07).
5. **Propostas futuras:** defaults operacionais, especialmente TTL de referência (A08–A12). O destino local wager-events.fifo foi solicitado para E1. São escolhas do desenho, não obrigações adicionais do desafio.

As propostas restantes não bloqueiam E1; serão revisadas na etapa correspondente. A autorização atual é executar somente E1 e parar ao concluí-la.

## Limites de escopo e conclusão

Autenticação fica adiada; ProviderIdentityPort e adaptador de desenvolvimento já estão registrados em E1. Não incluir IdP, usuários/senhas próprios, double-entry, event sourcing, barramento genérico, OpenTelemetry, dashboard ou teste de carga no caminho obrigatório. Não criar cadastro de provedores, fechamento de rodada ou regras de settlement ausentes no enunciado.

O desafio só estará concluído após E13. Documentar um mecanismo, criar uma constraint ou executar um teste unitário não comprova isoladamente a correção distribuída. No fechamento, registrar versões efetivas, comandos, ambiente, resultados, limites e riscos remanescentes. Carga é opcional; se adicionada depois, seguir o comando e a metodologia da §14.
