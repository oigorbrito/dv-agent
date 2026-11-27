# Google Antigravity ACP (isolated adapter)

The adapter uses the standalone `antigravity-acp` runtime from the official ACP Registry for both browser authentication and inference. It does **not** invoke `agy acp`, scrape credentials, reuse Google tokens in `auth.json`, or provide a proxy/fallback.

Runtime resolution is shared by login and provider execution:
- `DV_AGY_ACP_BIN` (preferred), then `AGY_ACP_BIN`
- `~/.local/opt/agy-acp/current/agy_acp_server.par` (or `.exe` on Windows)
- `~/.local/bin/agy_acp_server.par` (or `.exe` on Windows)
- standard system paths on Linux

The adapter never downloads or installs binaries automatically. Obtain the runtime from the official ACP Registry and verify its published SHA-256 before configuring the path.

## Authentication and runtime

- `dv auth login agy` starts the ACP runtime and calls `authenticate` with `oauth-personal` only when that method is advertised by the server. The runtime owns the browser flow and credential storage.
- `dv probe --live --provider agy --model gemini-3.8-flash-high --turns 1` performs one real prompt operation through the **same configured binary**.
- The provider session opened by `openLiveSession()` also uses this same binary. No Google token is copied into DV's `auth.json`.

`checkAgySession()` is read-only with respect to authentication: it performs ACP `initialize` and `session/new`, never `authenticate` and never `session/prompt`. Both login and session-check close the child process in a `finally` block.

## Scope and limits

The first integration slice is limited to provider selection, browser login, and one runtime prompt. No multi-account management, reverse-engineered HTTP API, proxy, MCP bridge, or advanced streaming behavior is added here. The DV core adapter is reused as-is; the standalone runtime command is injected from `dv-eval`.

Live operation requires an installed, authenticated standalone runtime. Automated tests use a fake ACP process and do not claim that the real Google service was exercised.
