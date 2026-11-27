import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAgySession, loginAgy, resolveAgyAcpRuntime } from "../src/auth/agy_auth.ts";

function fakeRuntime(): { binary: string; log: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "dv-agy-acp-"));
  const binary = join(dir, "agy_acp_server.par");
  const log = join(dir, "requests.log");
  const script = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.DV_AGY_TEST_LOG, request.method + "\\n");
  let result = {};
  if (request.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentInfo: { name: "fake-antigravity" },
      authMethods: [{ id: "oauth-personal" }]
    };
  } else if (request.method === "session/new") {
    result = { sessionId: "fake-session" };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  return { binary, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withFakeRuntime<T>(fn: (log: string) => Promise<T>): Promise<T> {
  const fake = fakeRuntime();
  const previousBin = process.env.DV_AGY_ACP_BIN;
  const previousLog = process.env.DV_AGY_TEST_LOG;
  process.env.DV_AGY_ACP_BIN = fake.binary;
  process.env.DV_AGY_TEST_LOG = fake.log;
  try {
    return await fn(fake.log);
  } finally {
    if (previousBin === undefined) delete process.env.DV_AGY_ACP_BIN;
    else process.env.DV_AGY_ACP_BIN = previousBin;
    if (previousLog === undefined) delete process.env.DV_AGY_TEST_LOG;
    else process.env.DV_AGY_TEST_LOG = previousLog;
    fake.cleanup();
  }
}

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

test("login solicita oauth-personal e confirma sessão sem expor credenciais", async () => {
  await withFakeRuntime(async (log) => {
    const result = await loginAgy();
    assert.equal(result.status, "authenticated");
    assert.equal(result.agentName, "fake-antigravity");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["initialize", "authenticate", "session/new"]);
  });
});

test("verificação de sessão é somente leitura e não dispara autenticação nem prompt", async () => {
  await withFakeRuntime(async (log) => {
    const result = await checkAgySession();
    assert.equal(result.status, "ready");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["initialize", "session/new"]);
  });
});
