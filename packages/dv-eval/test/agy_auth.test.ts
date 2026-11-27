import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgyAcpRuntime } from "../src/auth/agy_auth.ts";

test("não usa agy CLI nem fallback quando o runtime standalone está ausente", () => {
  const result = resolveAgyAcpRuntime({ PATH: "/no-such-path", HOME: "/no-such-home" }, "linux");
  assert.equal(result, null);
});

test("resolve somente binário standalone explicitamente configurado e executável", () => {
  const dir = mkdtempSync(join(tmpdir(), "dv-agy-acp-"));
  try {
    const binary = join(dir, "agy_acp_server.par");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    assert.equal(resolveAgyAcpRuntime({ DV_AGY_ACP_BIN: binary }, "linux"), binary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configuração inválida não cai para agy acp", () => {
  const result = resolveAgyAcpRuntime({ DV_AGY_ACP_BIN: "/missing/agy_acp_server.par", PATH: "/usr/bin" }, "linux");
  assert.equal(result, null);
});
