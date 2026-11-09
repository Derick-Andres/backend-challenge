# Evidências da validação

Execução iniciada em 2026-11-08T20:06:02.714Z, Bun 1.4.4. Logs: artifacts/validation/2026-11-08T20-06-02.713Z.

| Verificação | Estado | Segundos | Resultado |
|---|---|---|---|
| install | passed | 0.01 | Concluído |
| infra | passed | 0.65 | Concluído |
| build | passed | 4.11 | Concluído |
| database | passed | 0.24 | Concluído |
| typecheck | passed | 5.63 | Concluído |
| unit | passed | 0.11 | 241 passaram; 0 falharam |
| integration | passed | 93.53 | 109 passaram; 0 falharam |
| smoke | passed | 19.05 | 9 passaram; 0 falharam |
| migration-pending | passed | 0.27 | Concluído |

CHALLENGE SHA-256: 47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e.

Reproduza com `bun run verify`, após preparar .env conforme README. Integração e smoke usam serviços reais; interrompem temporariamente somente PostgreSQL/LocalStack deste Compose e restauram-nos. Não execute outras suítes nesses serviços ao mesmo tempo.
