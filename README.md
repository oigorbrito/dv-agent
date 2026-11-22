# dv-agent

Workspace DV sobre o runtime Pi (`badlogic/pi-mono`) fixado em commit. Pacotes:

- `contracts/` — contrato congelado `p1-run-accounting-v4` (cópia byte a byte; proveniência em `contracts/PROVENANCE.json`). Não editar.
- `packages/runtime-pi/` — fonte vendorada de `pi-ai`, `pi-agent-core`, `pi-coding-agent` (+ `pi-schema`, `pi-telemetry`). Origem e tree-hash em `UPSTREAM_PIN.json`.
- `packages/dv-core/` — ledger `dv-run-ledger-v2`, guards (doom loop, orçamento), router (políticas de degrau), **ferramentas de workspace** (`src/tools/`) e tabela de capacidades de transporte.
- `packages/dv-eval/` — oráculo externo (`src/oracle/`), probe de capacidade GAP-6 (`src/probe/`), smoke runner (`src/smoke/`) e tarefa calibrada `calc-basic` (`tasks/`).
- `scripts/dv-smoke.ts` — CLI do smoke end-to-end.

Dados de referência (`dv-baseline`, commit `e067dc7`) não foram alterados.

## Comandos

```bash
npm install --ignore-scripts
npm run hydrate:pi-ai-data        # uma vez, com rede (catálogo do pi-ai, gitignored)
npm run build:runtime             # compila pacotes de runtime
npm run typecheck
npm run lint                      # Biome 2.3.5 (mesma versão fixada pelo upstream)
npm test                          # 54 testes offline, sem rede e sem provedor real
npm run probe:providers           # probe offline (padrão, sem rede)
npm run probe:providers -- --live --provider P --model M   # chamadas reais; NÃO executado nesta fase
node scripts/dv-smoke.ts --policy single|ladder|architect-editor [--auth-mode offline-faux|api-key]
    [--model provider/modelId] [--escalation-model provider/modelId] [--outdir DIR] [--max-cost USD]
```

## Ferramentas de workspace (`packages/dv-core/src/tools/`)

Quatro `AgentTool` do pi-agent-core confinadas a `workspaceRoot`:

- `read_file` — `offset` (1-based) e `limit` em linhas; saída truncada com início e fim.
- `write_file` — escrita atômica (temporário no mesmo diretório, fsync, rename).
- `edit_file` — `old_text` exato; erro claro se ausente (`trecho não encontrado`) ou ambíguo (`N ocorrências`). Converte LF para CRLF quando o arquivo usa CRLF.
- `run_bash` — cwd fixo na raiz, stdin fechado, timeout explícito (encerra a árvore de processos), saída truncada, recusa comandos destrutivos.

Caminhos absolutos, `..` que escapem, e links/junctions que apontem para fora são recusados (`WorkspaceViolation`, com `code`). **Limite:** a denylist de `run_bash` é defesa em profundidade, não sandbox de processo.

## Oráculo externo

`runOracle` copia o workspace do agente (sem symlinks e sem bytecode) para um diretório isolado, roda o `check.py` da **pasta da tarefa** e grava `result.json` (`dv-oracle-result-v1`) com: veredito `PASS`/`FAIL`/`NO_VERDICT`, outcome `SOLVED`/`FAILURE`/`INCONCLUSIVE`, hashes do oráculo e do candidato, e resumo do `ledger.jsonl` com conformidade. O veredito do oráculo é soberano: sinais de runtime só refinam `FAIL` (`doom_loop`, `budget_exceeded`).

## Política e escalonamento

`ExecutionGuidedLadderPolicy` promove quando o status está em `escalate_on_statuses`, padrão `["fail", "doom_loop", "budget_exceeded"]`. `provider_error` fica fora da promoção automática. O contrato v4 cita o campo sem fixar o valor; a escolha é deste projeto.

## Tabela de capacidades do transporte pi-ai

`PI_TRANSPORT_CAPABILITIES` (em `dv-core/src/ledger/capabilities.ts`) declara, por `api`, se `reasoning_tokens`, `cache_read_tokens` e `cache_write_tokens` são `exposed` ou `not_exposed`, com a fonte no código do pi-ai. Campo `not_exposed` que chega nulo vira `declared_not_exposed` e **não** falta na telemetria. Campo `exposed` ausente continua falha. Famílias sem linha (`mistral-conversations`, `bedrock-converse-stream`, `pi-messages`) não são declaradas.

## Probe de capacidade (GAP-6)

- **Offline** (`npm run probe:providers`): valida a forma do `usage` produzida pelo caminho real do pi-ai (provider faux, cache por `sessionId`) e a consistência da tabela. Resultado `OFFLINE_SHAPE_CHECKED`. **Não promove provedor**: forma do faux não é comportamento de provedor real.
- **Live** (`--live`): duas chamadas com prefixo longo e mesmo `sessionId`. `VERIFIED` só se a segunda chamada reporta cache, `prompt_tokens` é estável e `cacheRead` não passa do prompt. Só `VERIFIED` aprova um provedor PROVISIONAL (`loadApprovedProbes` → `assertProviderCanRun`).

## Smoke end-to-end

Tarefa `calc-basic`: `calc.py` com `add` errado; o oráculo testa `add`, `mul` e `safe_div`. Modo `offline-faux` usa roteiros determinísticos (`offline_scripts.ts`): o modelo barato erra, o forte acerta. Não avalia modelo real. Resultados offline:

| política | resultado | degraus |
|---|---|---|
| single | unsolved | barato: FAIL |
| ladder | solved | barato: FAIL → forte: PASS |
| architect-editor | solved | arquiteto (sem oráculo) → editor: PASS |

Modo `api-key` passa pelo gate de capacidade e para com `blocked` se o provedor for PROVISIONAL sem probe. **Não foi executado com provedor real.**

## Mapeamento ao contrato v4

| Regra | Onde | Verificação |
|---|---|---|
| a. ortogonalidade | `ledger/telemetry.ts`, `ledger/conformance.ts` | `ledger_contract`, `transport_capabilities` |
| b. uncached por capacidade; PROVISIONAL bloqueia | `ledger/capabilities.ts`, `execute_rung.ts` | `probe.test.ts`, `smoke.test.ts` (gate) |
| c. teto acumulado e promoção | `guards/budget.ts`, `router/policy.ts` | `budget`, `ladder`, `smoke` |
| d. rastreabilidade por run | `run_started` + `conformance.ts` | campos ausentes são violação |

## Lacunas conhecidas

1. **Nenhum provedor real foi verificado.** `anthropic` segue com a linha `CODE_VERIFIED_OFFLINE` do contrato; `gemini` e `openai` seguem PROVISIONAL e bloqueiam execução. A promoção para `VERIFIED` exige rodar `--live` com credencial, o que não foi feito.
2. **Corte por orçamento é posterior à chamada.** Pode haver estouro de uma chamada; o ledger registra `exceeded`.
3. **Chamada declarada sem resultado** é registrada como `not_executed` quando não há `toolResult`. O caminho do corte testado produz `error` (o loop devolve erro para a ferramenta abortada); o caminho `not_executed` ainda não tem teste dedicado.
4. **Architect/editor** não tem evidência congelada que sustente vantagem; é contrato de decisão (`MECHANISM_AVAILABLE != MECHANISM_NECESSARY`).
5. **`pi-coding-agent` vendorado, não compilado nem importado.**
6. **`run_bash` não é sandbox.** Denylist e cwd limitam o uso acidental, não um comando malicioso.
7. **`reasoning` e `cache` em runs reais** dependem da tabela de transporte. Se um transporte expuser o campo só em alguns casos, a declaração pode estar errada e precisa de probe live.
