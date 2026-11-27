# dv-agent

[English](#english) | [Português](#português)

---

## English

### Overview

`dv-agent` (CLI binaries `dv` and `dv-agent`) is an interactive terminal agent and deterministic evaluation harness that runs directly in your current working directory (`process.cwd()`). It combines workspace-confined tools, multi-step routing policies, and preserved run-accounting contracts (`v4` and `v5`).

- **Interactive & single-task execution:** run `dv` for a REPL session or `dv "<task>"` to execute a task directly in the current workspace (silently writing ledgers to `.dv/runs/<timestamp>/`).
- **Evaluation & routing:** deterministic `smoke`, `bench`, `metrics`, and `probe` subcommands built on frozen accounting contracts (`contracts/run-accounting-contract-v4.json` and `contracts/run-accounting-contract-v5.json`).

### Installation & Quick Start

Requires **Node.js `>=22.19.0`**.

```bash
# From source (local build + global install)
npm install --ignore-scripts
npm run hydrate:pi-ai-data        # once, online (fetches pi-ai model catalog)
npm run build:runtime
npm run build:dist && npm install -g .

# Or install the published package directly
npm install -g @engfinecode/dv-agent
```

> **Windows (PowerShell):** if the global npm bin folder is not in your `PATH`, add it to the current session:
> ```powershell
> $env:Path = "$(npm prefix -g);$env:Path"
> ```

Essential commands:

| Command | Description |
|---|---|
| `dv` / `dv-agent` | Start an interactive REPL session in `process.cwd()` |
| `dv "<task>"` | Run a single task directly in the current workspace |
| `dv --login` | Open the interactive authentication and route menu on startup |
| `dv update` | Update `@engfinecode/dv-agent` globally (`npm install -g @engfinecode/dv-agent@latest`) |
| `dv --help` / `dv --version` | Show CLI help or current package version |

Startup also performs a non-blocking npm version check (`1.5s` timeout) that stays silent when offline.

### Authentication & Routes

When no active credential is detected—or via `dv --login` / `/login`—the interactive menu presents 4 options:

1. **Browser / subscription (`subscription`):** OAuth login for `anthropic`, `openai-codex`, or `agy`.
2. **API key (`api-key`):** reads the provider environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`) or prompts and stores the key in `auth.json` with `0600` permissions.
3. **Free route (`free`):** configures `google` or `groq` (`api-key`).
4. **Paid route (`paid`):** configures `anthropic`, `openai`, `openrouter`, or `deepseek` (`api-key`).

**Session resolution, persistence, and catalog validation:**

- **Credential path (`resolveAuthPath()`):** resolved consistently across Windows and Linux/WSL in order: `DV_AUTH_FILE` → `PI_CODING_AGENT_DIR/auth.json` → `~/.pi/agent/auth.json`.
- **User preferences:** saved to `~/.dv/config.json` (`model`, `policy`, `maxTokens`).
- **Strict catalog validation:** models are validated against the `agy` and `pi-ai` catalogs; invalid placeholders such as `radius/balanced` or unknown model IDs are rejected/ignored and replaced by a valid default for the authenticated provider.

### REPL Commands & Evaluation

Interactive slash commands:

| Command | Purpose |
|---|---|
| `/help` | List available REPL commands |
| `/model [provider/model]` | Show or switch the active model (catalog-validated) |
| `/policy [single\|ladder\|predictive-harness-router]` | Show or switch the active routing policy |
| `/tokens` | Display accumulated session token usage |
| `/login` | Reopen the authentication and route menu |
| `/exit` | Exit the REPL session (`/quit` is also accepted) |

Deterministic evaluation & diagnostic subcommands:

| Subcommand | Purpose |
|---|---|
| `dv auth login agy` | Browser OAuth login via the official standalone ACP runtime |
| `dv smoke [options]` | Run end-to-end smoke checks (`single`, `ladder`, `architect-editor`, `predictive-harness-router`) |
| `dv bench [options]` | Run multi-policy benchmarks |
| `dv metrics [options] <outdir\|summary.json>` | Compute benchmark comparison metrics |
| `dv probe [options]` | Run provider capability checks (offline by default; `--live` for real calls) |

> **Frozen artifacts:** do not modify `contracts/run-accounting-contract-v4.json`, `contracts/run-accounting-contract-v5.json`, or `runs/` during day-to-day CLI or documentation changes.

Development checks:

```bash
npm run typecheck
npm run lint
npm test
```

---

## Português

### Visão Geral

O `dv-agent` (executáveis `dv` e `dv-agent`) é um agente interativo de terminal e harness determinístico de avaliação que roda diretamente no diretório atual (`process.cwd()`). Ele combina ferramentas confinadas ao workspace, políticas de roteamento em degraus e contratos preservados de contabilidade de execução (`v4` e `v5`).

- **Uso interativo e tarefa única:** execute `dv` para abrir o REPL ou `dv "<tarefa>"` para executar uma tarefa diretamente no workspace atual (gravando ledgers silenciosamente em `.dv/runs/<timestamp>/`).
- **Avaliação e roteamento:** subcomandos determinísticos `smoke`, `bench`, `metrics` e `probe` apoiados nos contratos congelados (`contracts/run-accounting-contract-v4.json` e `contracts/run-accounting-contract-v5.json`).

### Instalação e Início Rápido

Requer **Node.js `>=22.19.0`**.

```bash
# A partir do código-fonte (build local + instalação global)
npm install --ignore-scripts
npm run hydrate:pi-ai-data        # uma vez, com rede (baixa o catálogo de modelos do pi-ai)
npm run build:runtime
npm run build:dist && npm install -g .

# Ou instale o pacote publicado diretamente
npm install -g @engfinecode/dv-agent
```

> **Windows (PowerShell):** se o diretório global do npm ainda não estiver no `PATH`, adicione-o na sessão atual:
> ```powershell
> $env:Path = "$(npm prefix -g);$env:Path"
> ```

Comandos essenciais:

| Comando | Descrição |
|---|---|
| `dv` / `dv-agent` | Inicia uma sessão interativa (REPL) em `process.cwd()` |
| `dv "<tarefa>"` | Executa uma tarefa diretamente no workspace atual |
| `dv --login` | Abre o menu interativo de autenticação e rota na inicialização |
| `dv update` | Atualiza `@engfinecode/dv-agent` globalmente (`npm install -g @engfinecode/dv-agent@latest`) |
| `dv --help` / `dv --version` | Exibe a ajuda do CLI ou a versão instalada |

Na inicialização, o CLI também faz uma checagem não-bloqueante de versão no npm (timeout de `1,5s`), silenciosa quando offline.

### Autenticação e Rotas

Quando não há credencial ativa — ou via `dv --login` / `/login` — o menu interativo oferece 4 opções:

1. **Login via browser / assinatura (`subscription`):** fluxo OAuth para `anthropic`, `openai-codex` ou `agy`.
2. **Chave de API (`api-key`):** lê a variável de ambiente do provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`) ou solicita e salva a chave em `auth.json` com permissão `0600`.
3. **Rota gratuita (`free`):** configura `google` ou `groq` (`api-key`).
4. **Rota paga (`paid`):** configura `anthropic`, `openai`, `openrouter` ou `deepseek` (`api-key`).

**Resolução de sessão, persistência e validação de catálogo:**

- **Caminho de credenciais (`resolveAuthPath()`):** resolvido de forma consistente entre Windows e Linux/WSL na ordem: `DV_AUTH_FILE` → `PI_CODING_AGENT_DIR/auth.json` → `~/.pi/agent/auth.json`.
- **Preferências do usuário:** persistidas em `~/.dv/config.json` (`model`, `policy`, `maxTokens`).
- **Validação estrita no catálogo:** os modelos são validados nos catálogos `agy` e `pi-ai`; placeholders inválidos como `radius/balanced` ou IDs inexistentes são recusados/ignorados e substituídos por um padrão válido do provedor autenticado.

### Comandos do REPL e Avaliação

Comandos de barra no modo interativo:

| Comando | Função |
|---|---|
| `/help` | Lista os comandos disponíveis no REPL |
| `/model [provider/model]` | Mostra ou altera o modelo ativo (validado no catálogo) |
| `/policy [single\|ladder\|predictive-harness-router]` | Mostra ou altera a política de roteamento ativa |
| `/tokens` | Exibe o total de tokens acumulados na sessão |
| `/login` | Reabre o menu de autenticação e seleção de rota |
| `/exit` | Encerra a sessão do REPL (também aceita `/quit`) |

Subcomandos determinísticos de avaliação e diagnóstico:

| Subcomando | Função |
|---|---|
| `dv auth login agy` | Login OAuth pelo browser usando o runtime ACP oficial |
| `dv smoke [opções]` | Executa verificação end-to-end (`single`, `ladder`, `architect-editor`, `predictive-harness-router`) |
| `dv bench [opções]` | Executa benchmarks com múltiplas políticas |
| `dv metrics [opções] <outdir\|summary.json>` | Calcula métricas comparativas de benchmark |
| `dv probe [opções]` | Verifica capacidades dos provedores (offline por padrão; `--live` para chamadas reais) |

> **Artefatos congelados:** não altere `contracts/run-accounting-contract-v4.json`, `contracts/run-accounting-contract-v5.json` nem `runs/` em mudanças de uso diário ou documentação.

Verificações de desenvolvimento:

```bash
npm run typecheck
npm run lint
npm test
```
