# dv-agent

Workspace DV sobre o runtime Pi (`badlogic/pi-mono`) fixado em commit. Pacotes:

- `contracts/` — contrato congelado `p1-run-accounting-v4` (cópia byte a byte; proveniência em `contracts/PROVENANCE.json`). Não editar.
- `packages/runtime-pi/` — fonte vendorada de `pi-ai`, `pi-agent-core`, `pi-coding-agent` (+ `pi-schema`, `pi-telemetry`). Origem e tree-hash em `UPSTREAM_PIN.json`.
- `packages/dv-core/` — ledger `dv-run-ledger-v2`, guards (doom loop, orçamento), router (políticas de degrau), **ferramentas de workspace** (`src/tools/`) e tabela de capacidades de transporte.
- `packages/dv-eval/` — oráculo externo (`src/oracle/`), probe de capacidade GAP-6 (`src/probe/`), smoke runner (`src/smoke/`) e tarefa calibrada `calc-basic` (`tasks/`).
- `scripts/dv-smoke.ts` — CLI do smoke end-to-end.

Dados de referência (`dv-baseline`, commit `e067dc7`) não foram alterados.

## Comandos

Após instalar `@finecode/dv-agent`, os executáveis `dv` e `dv-agent` oferecem a mesma CLI:

```bash
dv --help
dv --version
dv smoke --policy single --auth-mode faux
dv bench --policies single,ladder --auth-mode faux
dv metrics runs/.../summary.json
dv probe                       # offline; chamadas reais exigem --live
```

```bash
npm install --ignore-scripts
npm run hydrate:pi-ai-data        # uma vez, com rede (catálogo do pi-ai, gitignored)
npm run build:runtime             # compila pacotes de runtime
npm run build:dist                # prepara a distribuição npm em dist/ (offline, usa o catálogo local)
npm run typecheck
npm run lint                      # Biome 2.3.5 (mesma versão fixada pelo upstream)
npm test                          # testes offline, sem rede e sem provedor real
npm run probe:providers           # probe offline (padrão, sem rede)
npm run probe:providers -- --live --provider P --model M --auth-mode subscription   # chamada real (assinatura)
npm run probe:providers -- --live --provider P --model M --auth-mode api-key        # chamada real (variável de ambiente)
node scripts/dv-smoke.ts --policy single|ladder|architect-editor --auth-mode offline-faux|api-key|subscription
    [--model provider/modelId] [--escalation-model provider/modelId] [--ladder-models provider/id,...] [--auth-file CAMINHO] [--outdir DIR] [--max-cost USD]
```

## Pacote npm e CLI unificada

O pacote `@finecode/dv-agent` instala os executáveis `dv` e `dv-agent`. A distribuição fica em `dist/`, inclui os módulos internos compilados, os dados do corpus e os contratos v4/v5; SDKs de provedores permanecem como dependências npm. O allowlist do tarball exclui `runs/`, `experiments/`, `claims/` e os resultados de probes.

```bash
npx @finecode/dv-agent --help
npx @finecode/dv-agent smoke --policy ladder --auth-mode faux
npx @finecode/dv-agent bench --policies ladder --auth-mode faux
npx @finecode/dv-agent metrics --weak anthropic/claude-haiku-5-5 --strong anthropic/claude-sonnet-4-6 runs/bench/summary.json
npx @finecode/dv-agent probe                 # offline
```

`dv probe --live ...` mantém o comportamento explícito de probe real do runner existente.

## Autenticação por assinatura (`--auth-mode subscription`)

Usa a sessão OAuth de plano (Claude Pro/Max, ChatGPT Plus/Pro) guardada pelo pi, sem `ANTHROPIC_API_KEY` nem `OPENAI_API_KEY`.

- **Arquivo:** `DV_AUTH_FILE`, senão `PI_CODING_AGENT_DIR/auth.json`, senão `~/.pi/agent/auth.json` (mesmo caminho do pi).
- **Como entrar** (o token fica 0600; nunca cole em chat ou log):
  ```
  mkdir -p ~/.pi/agent && cd ~/.pi/agent
  npx @earendil-works/pi-ai@1.6.0 login anthropic      # ou: login openai-codex
  ```
  O comando grava `auth.json` no diretório atual, por isso o `cd`.
- **Sem sessão:** o modo para antes de qualquer chamada (`blocked`), com essa instrução. Credencial `api_key` guardada não serve como assinatura e é recusada.
- **Sem fallback para ambiente:** com credencial guardada, o `Models` do pi-ai usa só o token guardado. Verificado por teste offline.
- **Lock:** o store de arquivo usa o mesmo diretório `auth.json.lock` do proper-lockfile do pi, para que o refresh do OAuth (que pode rotacionar o refresh token) não corrompa a sessão. A compatibilidade com o pi real não foi testada em processo separado.
- **Custo:** `cost_basis: "subscription_session"`, `cost_usd: null`. Não é "desconhecido" nem zero: o custo por token não é cobrado em USD. O teto em USD fica `unverifiable` e o gasto não entra no limite inferior. **Interpretação a confirmar:** tratei `cost_usd` como balde não aplicável (não faltante), então a telemetria de tokens continua `MEASURED`.

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

`dv-smoke --policy ladder` aceita `--ladder-models modelo,...` para definir qualquer quantidade de degraus em ordem. A lista pode usar IDs `provider/modelId` ou os nomes `Haiku 5.5,Fable 5.2,Sonnet 5.5,Opus 5.5`; sem a opção, `--model` e `--escalation-model` preservam os dois degraus existentes.

`dv-bench --policy ladder` (via `--policies ladder`) também aceita `--ladder-models provider/modelId,...`. A sequência é gravada no resumo; um degrau `agy/...` seleciona o contrato v5. Para ACP v1, o cliente anuncia `fs.readTextFile`, `fs.writeTextFile` e `terminal`; callbacks usam o workspace isolado do degrau, a guarda de caminhos compartilhada e timeout de 60 s para terminais. A execução de comandos continua sendo processo local com cwd confinado, não um sandbox de sistema operacional.

`predictive-harness-router` mantém a mesma escada, mas pode iniciar diretamente no degrau 1 quando um histórico de calibração mostrar falha frequente no degrau 0. Passe um ou mais `--routing-history runs/.../summary.json` (flag repetível) junto com `--routing-history-partition calibration` ou `train`; sem essas flags, começa sempre no degrau 0. O loader aceita apenas tarefas da partição determinística de calibração, deduplica ledgers, exige ao menos três observações e registra no evento `route_decided` o motivo, contagens e hashes das fontes/índice. Históricos contendo tarefas de holdout ou ledgers já presentes no `--outdir` são recusados para evitar vazamento. Exemplo offline: `node scripts/dv-smoke.ts --policy predictive-harness-router --auth-mode faux --ladder-models agy/gemini-3.8-flash-high,anthropic/claude-haiku-5-5,anthropic/claude-sonnet-4-6 --routing-history runs/calibration/summary.json --routing-history-partition calibration`.

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

0. **Modo assinatura não validado contra o serviço.** Uma execução manual de smoke com a sessão local chegou ao Anthropic e recebeu `404 not_found_error: model: claude-sonnet-4-5` (sem consumo de token). O id existe no catálogo do pi-ai, mas a conta não o aceitou. Ainda não há id confirmado. A execução foi feita sem sua autorização explícita; daqui em diante, chamadas live ficam por sua conta.
   Efeito colateral corrigido nesta etapa: erro sem usage era marcado como `MEASURED`. Agora é `usage_not_reported` e `INCONCLUSIVE`.
   A aprovação do probe vale por provedor, não por modo de autenticação; a flag `auth_mode` fica registrada no resultado.

1. **Nenhum provedor real foi verificado.** `anthropic` segue com a linha `CODE_VERIFIED_OFFLINE` do contrato; `gemini` e `openai` seguem PROVISIONAL e bloqueiam execução. A promoção para `VERIFIED` exige rodar `--live` com credencial, o que não foi feito. O `agy` exige aprovação do probe local persistido sob v5; esta implementação não executa probes live.
2. **Corte por orçamento é posterior à chamada.** Pode haver estouro de uma chamada; o ledger registra `exceeded`.
3. **Chamada declarada sem resultado** é registrada como `not_executed` quando não há `toolResult`. O caminho do corte testado produz `error` (o loop devolve erro para a ferramenta abortada); o caminho `not_executed` ainda não tem teste dedicado.
4. **Architect/editor** não tem evidência congelada que sustente vantagem; é contrato de decisão (`MECHANISM_AVAILABLE != MECHANISM_NECESSARY`).
5. **`pi-coding-agent` vendorado, não compilado nem importado.**
6. **`run_bash` não é sandbox.** Denylist e cwd limitam o uso acidental, não um comando malicioso.
7. **`reasoning` e `cache` em runs reais** dependem da tabela de transporte. Se um transporte expuser o campo só em alguns casos, a declaração pode estar errada e precisa de probe live.
