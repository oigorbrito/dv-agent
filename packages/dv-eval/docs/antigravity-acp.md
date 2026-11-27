# Google Antigravity ACP (isolated adapter)

This adapter targets Google's standalone `antigravity-acp` runtime from the official ACP Registry. It does **not** invoke `agy acp`, scrape credentials, reuse Google tokens in `auth.json`, or provide a proxy/fallback.

Runtime resolution:
- `DV_AGY_ACP_BIN` (preferred), then `AGY_ACP_BIN`
- `~/.local/opt/agy-acp/current/agy_acp_server.par` (or `.exe` on Windows)
- `~/.local/bin/agy_acp_server.par` (or `.exe` on Windows)
- standard system paths on Linux

The adapter never downloads or installs binaries automatically. Obtain the runtime from the official ACP Registry and verify its published SHA-256 before configuring the path.

`checkAgySession()` is read-only with respect to authentication: it performs ACP initialize and session/new, never authenticate and never session/prompt. `loginAgy()` calls ACP `authenticate` using `oauth-personal` only when advertised by the runtime, then verifies session/new. Both paths close the child process in a finally block.

Current limitation: the CLI dispatcher is not wired yet. The module is deliberately isolated until protocol behavior is exercised against the installed Google runtime.
