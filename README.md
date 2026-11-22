# dv-agent

Workspace DV sobre o runtime Pi (`badlogic/pi-mono`) fixado em commit. Contém:

- `contracts/` — contrato congelado `p1-run-accounting-v4` (cópia byte a byte; ver `contracts/PROVENANCE.json`).
- `packages/runtime-pi/` — fonte vendorada de `pi-ai`, `pi-agent-core`, `pi-coding-agent` (+ `pi-schema`, `pi-telemetry`, dependências de runtime do `pi-ai`). Origem e tree-hash em `UPSTREAM_PIN.json`.
- `packages/dv-core/` — ledger `dv-run-ledger-v2`, guards (doom loop, orçamento) e router (políticas de degrau).

Dados de referência (`dv-baseline`, commit `e067dc7`) não foram alterados.

## Comandos

```bash
npm install --ignore-scripts      # workspace; --ignore-scripts evita hooks upstream
npm run hydrate:pi-ai-data        # uma vez, com rede: gera catálogo de modelos do pi-ai (gitignored)
npm run build:runtime             # compila schema, telemetry, ai, agent-core e copia dados
npm run typecheck
npm test                          # testes offline, sem rede e sem provedor real
```

## Mapeamento ao contrato v4

| Regra | Onde | Verificação |
|---|---|---|
| a. ortogonalidade (`telemetry_complete`, `cost_accounting_status`) | `src/ledger/telemetry.ts`, `conformance.ts` | `test/ledger_contract.test.ts` |
| b. uncached por capacidade; PROVISIONAL bloqueia | `src/ledger/capabilities.ts`, `prices.ts` | `assertProviderCanRun` em `execute_rung.ts` |
| c. teto acumulado e promoção | `src/guards/budget.ts`, `src/router/policy.ts` | `test/budget.test.ts`, `test/ladder.test.ts` |
| d. rastreabilidade por run | `run_started` + `conformance.ts` | campos ausentes são violação |

## Escopo do que foi verificado

- Testes usam o provider `faux` do pi-ai e um shim de teste que substitui o `usage` do evento `done` pelo valor declarado. Nenhuma chamada a provedor real foi feita.
- `ledger_sha256` é calculado após `close()` sobre os bytes do arquivo (`ledgerSha256`), não gravado dentro do próprio ledger.
- Saída de ferramenta é gravada redigida; `raw_output_sha256` é o digest dos bytes **antes** da redação (auditoria bruta, regra v3 mantida).

## Lacunas conhecidas (não resolvidas aqui)

1. **Capacidade do provedor.** A linha `anthropic` da tabela (regra b) é o resultado verificado no litellm 1.110.1; a equivalência com `usage.input` do pi-ai não foi re-verificada. `gemini` e `openai` são PROVISIONAL e bloqueiam execução sem probe aprovado. O probe (GAP-6) não foi implementado.
2. **`reasoning_tokens` e `cache_read`.** O contrato v4 só permite `null` quando a tabela declara o campo como não exposto, e a tabela não tem essa declaração. O pi-ai só preenche `reasoning` em alguns caminhos; logo, a maioria dos runs reais sairá `INCONCLUSIVE`. Isso é consequência literal do contrato congelado e precisa de decisão do usuário, não de ajuste silencioso.
3. **`escalate_on_statuses`.** O contrato v4 cita o campo, mas nenhum artefato congelado do baseline o define. O padrão `["fail"]` é escolha deste código e fica como parâmetro.
4. **Corte por orçamento é posterior à chamada.** O `BudgetGuard` corta após `message_end` com custo medido. Um estouro de uma chamada é possível; o ledger então registra `ceiling_status: exceeded`, que pelo contrato invalida o run. Não há limite preventivo por chamada.
5. **Architect/editor.** Não há evidência congelada que sustente essa política; está implementada como contrato de decisão, sem claim de vantagem (`MECHANISM_AVAILABLE != MECHANISM_NECESSARY`).
6. **`pi-coding-agent` vendorado, não compilado nem importado.** Seu fechamento (`pi-tui`, `pi-mcp`, `pi-codemode`) não foi vendorado.
7. **`not_executed`.** O caminho de registro para chamada declarada sem nenhum resultado existe, mas não há teste que o exercite (o loop emite resultado de erro no caso de corte testado).
