# dv-agent

Agente interativo de terminal e harness determinístico sobre o runtime Pi (`badlogic/pi-mono`) fixado em commit. Pacotes e diretórios principais:

- `contracts/` — contratos congelados `run-accounting-contract-v4.json` (`p1-run-accounting-v4`) e `run-accounting-contract-v5.json` (proveniência em `contracts/PROVENANCE.json`). **Não editar.**
- `runs/` — artefatos e históricos de execução congelados. **Não editar.**
- `packages/runtime-pi/` — fonte vendorada de `pi-ai`, `pi-agent-core`, `pi-coding-agent` (+ `pi-schema`, `pi-telemetry`). Origem e tree-hash em `UPSTREAM_PIN.json`.
- `packages/dv-core/` — ledger `dv-run-ledger-v2`, guards (doom loop, orçamento), router (políticas de degrau), **ferramentas de workspace** (`src/tools/`) e tabela de capacidades de transporte.
- `packages/dv-eval/` — oráculo externo (`src/oracle/`), probe de capacidade GAP-6 (`src/probe/`), smoke runner (`src/smoke/`) e tarefa calibrada `calc-basic` (`tasks/`).
- `src/` — CLI unificada (`src/cli.ts`) e modo interativo / tarefa única (`src/interactive.ts`).
- `scripts/` — entrypoints dos runners (`dv-smoke.ts`, `dv-bench.ts`, `dv-bench-metrics.ts`, `build-dist.mjs`, `build-runtime.mjs`).

Dados de referência (`dv-baseline`, commit `e067dc7`) permanecem preservados.

## Início Rápido e Uso Interativo (`dv` / `dv-agent`)

Após instalar `@engfinecode/dv-agent` (via npm ou build local), os executáveis `dv` e `dv-agent` funcionam diretamente em qualquer diretório de projeto (`process.cwd()`):

```bash
# Abrir sessão interativa (REPL) no diretório atual
dv
dv-agent

# Executar uma tarefa diretamente no workspace atual (grava ledger silenciosamente em .dv/runs/<timestamp>/)
dv "corrija o bug de validação em src/auth.ts"

# Abrir o menu de autenticação e seleção de rota logo na inicialização
dv --login

# Atualizar o pacote globalmente via npm (npm install -g @engfinecode/dv-agent@latest)
dv update
```

- **Execução direta no workspace:** `dv "<sua tarefa>"` roda no `process.cwd()` atual usando as ferramentas confinadas ao workspace e grava o ledger da execução silenciosamente em `.dv/runs/<timestamp>/turn-<N>.ledger.jsonl`.
- **Checagem não-bloqueante de versão:** ao iniciar o modo interativo ou tarefa única, o `dv` consulta `https://registry.npmjs.org/@engfinecode/dv-agent/latest` com timeout de **1,5 s** (`1500 ms`) e avisa se houver versão mais nova disponível; quando offline ou em caso de falha de rede, a checagem falha silenciosamente sem atrasar ou interromper a execução.

### Build e instalação global a partir do código-fonte

```bash
npm install --ignore-scripts
npm run hydrate:pi-ai-data        # uma vez, com rede (catálogo do pi-ai, gitignored)
npm run build:runtime             # compila pacotes de runtime
npm run build:dist                # gera a distribuição em dist/ (offline, usa o catálogo local)
npm install -g .                  # instala globalmente os comandos dv e dv-agent
```

No **PowerShell (Windows)**, caso o diretório global do npm ainda não esteja no `PATH` da sessão atual:

```powershell
$env:Path = "$(npm prefix -g);$env:Path"
```

## Autenticação, Rotas (`free` / `paid`) e Persistência

### Menu interativo (`promptLoginMenu`)

Quando nenhuma credencial ativa é detectada — ou ao executar `dv --login` / usar `/login` no REPL — o `dv` exibe o menu interativo (`promptLoginMenu`) com 4 opções:

1. **Login via browser / assinatura (`subscription`):** fluxo OAuth para `anthropic`, `openai-codex` ou `agy`.
2. **Chave de API (`api-key`):** suporta `anthropic`, `openai`, `google`, `groq`, `openrouter` e `deepseek`; lê a variável de ambiente correspondente (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`) quando definida ou solicita a chave interativamente e a salva em `auth.json` com permissão `0600`.
3. **Rota gratuita (`free`):** configura `google` (padrão `google/gemini-2.5-flash`) ou `groq` (padrão `groq/llama-3.3-70b-versatile`) via `api-key`.
4. **Rota paga (`paid`):** configura `anthropic` (padrão `anthropic/claude-haiku-4-5`), `openai` (padrão `openai/gpt-4.1`), `openrouter` ou `deepseek` (padrão `deepseek/deepseek-flash`) via `api-key`.

### Validação de catálogo (`isValidCatalogModel` / `defaultModelForProvider`)

- `isValidCatalogModel(provider, modelId)` valida `provider/modelId` contra o catálogo suportado (`agy` ou `pi-ai`), rejeitando placeholders como `radius/balanced` e IDs de modelo inexistentes.
- `defaultModelForProvider(provider)` deriva automaticamente um modelo válido para o provedor autenticado (priorizando os modelos preferidos do provedor e caindo para o catálogo do `pi-ai`).

### Resolução de sessão e configuração do usuário

- **Arquivo de credenciais (`resolveAuthPath()`):** usa a mesma resolução consistente entre Windows e Linux/WSL:
  1. `DV_AUTH_FILE`
  2. `PI_CODING_AGENT_DIR/auth.json`
  3. `~/.pi/agent/auth.json`
- **Persistência em `~/.dv/config.json`:** salva `model`, `policy` e `maxTokens`. Ao carregar (`loadDvUserConfig`), modelos inválidos antigos (como `radius/balanced`) e políticas desconhecidas são ignorados automaticamente, mantendo apenas valores válidos.
- **Autenticação por assinatura (`--auth-mode subscription`):** usa a sessão OAuth guardada em `auth.json` (lock em `auth.json.lock`, sem fallback para variável de ambiente de API key). O custo é registrado com `cost_basis: "subscription_session"` e `cost_usd: null`.

## Comandos do REPL e Subcomandos Determinísticos

### Comandos de barra no modo interativo

| Comando | Descrição |
|---|---|
| `/help` | Mostra a lista de comandos do REPL |
| `/model [provider/model]` | Mostra ou altera o modelo atual (validado no catálogo) |
| `/policy [single\|ladder\|predictive-harness-router]` | Mostra ou altera a política ativa |
| `/tokens` | Mostra os tokens acumulados da sessão (`calls`, `prompt_tokens`, `completion_tokens`, `total_tokens`) |
| `/login` | Abre o menu interativo de login (`browser/assinatura`, `api-key`, `free`, `paid`) |
| `/exit` | Encerra a sessão interativa (também aceita `/quit`) |

### Subcomandos determinísticos de avaliação e experimento

Os subcomandos preservam os parsers e opções dos runners existentes:

```bash
dv --help
dv --version
dv smoke --policy single --auth-mode faux
dv bench --policies single,ladder --auth-mode faux
dv metrics --baseline single --treatment ladder runs/.../summary.json
dv probe                       # offline; chamadas reais exigem --live
dv auth login agy              # login interativo via browser do runtime ACP oficial
```

- **Políticas disponíveis nos runners:** `single`, `ladder`, `architect-editor` e `predictive-harness-router` (no REPL interativo, `/policy` alterna entre `single`, `ladder` e `predictive-harness-router`).
- **Contratos congelados e `runs/`:** os contratos `contracts/run-accounting-contract-v4.json` (`v4`) e `contracts/run-accounting-contract-v5.json` (`v5`, selecionado automaticamente para modelos `agy/...`) e os históricos em `runs/` são preservados intactos; o tarball npm inclui `dist/`, `bin/`, `contracts/run-accounting-contract-v4.json`, `contracts/run-accounting-contract-v5.json`, `README.md` e `LICENSE`, excluindo `runs/`, `experiments/`, `claims/` e resultados de probes.

### Scripts de desenvolvimento e verificação

```bash
npm run typecheck
npm run lint                      # Biome 2.3.5 (mesma versão fixada pelo upstream)
npm test                          # testes offline, sem rede e sem provedor real
npm run probe:providers           # probe offline (padrão, sem rede)
npm run probe:providers -- --live --provider P --model M --auth-mode subscription
npm run probe:providers -- --live --provider P --model M --auth-mode api-key
```

### Effort laddering e scaffold adaptativo

```bash
# Esforço de raciocínio por degrau (provider/modelId:effort; effort em low|medium|high|xhigh)
node scripts/dv-smoke.ts --policy ladder --ladder-models anthropic/claude-haiku-5-5:low,anthropic/claude-sonnet-4-6:high

# Scaffold por porte do modelo (uniform é o padrão)
node scripts/dv-smoke.ts --policy ladder --scaffold-mode adaptive --ladder-models anthropic/claude-haiku-5-5:low,anthropic/claude-sonnet-4-6:high
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
