// Integração isolada com o runtime ACP standalone oficial do Google.
// Não usa "agy acp", auth.json, tokens exportados, proxy ou fallback alternativo.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type AgySessionStatus = "ready" | "not_ready";
export interface AgySessionCheck {
  status: AgySessionStatus;
  runtime: string | null;
  reason?: string;
  agentName?: string;
}
export interface AgyLoginResult { status: "authenticated"; runtime: string; agentName?: string }

const AUTH_METHOD = "oauth-personal";
const TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = 1;

export function resolveAgyAcpRuntime(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const explicit = env.DV_AGY_ACP_BIN?.trim() || env.AGY_ACP_BIN?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(homedir(), ".local", "opt", "agy-acp", "current", platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"),
    join(homedir(), ".local", "bin", platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"),
    ...(platform === "win32" ? [] : ["/usr/local/bin/agy_acp_server.par", "/usr/bin/agy_acp_server.par"]),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(resolve(candidate), constants.X_OK);
      return resolve(candidate);
    } catch {
      // Runtime ausente ou não executável; nunca substitui por "agy acp".
    }
  }
  return null;
}

interface RpcMessage { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: { code?: number; message?: string } }
class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(binary: string) {
    this.child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`ACP process exited (code=${code}, signal=${signal})`)));
  }
  request(method: string, params: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP process closed"));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error) {
          const entry = this.pending.get(id);
          if (entry) { clearTimeout(entry.timer); this.pending.delete(id); entry.reject(error); }
        }
      });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("ACP process closed")); }
    this.pending.clear();
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolvePromise) => this.child.once("exit", () => resolvePromise())), delay(1500)]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        let message: RpcMessage;
        try { message = JSON.parse(line) as RpcMessage; } catch { this.fail(new Error("Invalid JSON-RPC frame from ACP runtime")); return; }
        if (typeof message.id !== "number") { newline = this.buffer.indexOf("\n"); continue; }
        const entry = this.pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message ?? `ACP error ${message.error.code ?? "unknown"}`));
          else entry.resolve(message.result);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}

async function initialize(rpc: RpcProcess): Promise<{ agentName?: string; authMethods: Array<{ id?: string; methodId?: string }> }> {
  const raw = await rpc.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "dv-agent", version: "0.1.0" },
  }) as { agentInfo?: { name?: string }; authMethods?: Array<{ id?: string; methodId?: string }> };
  return { agentName: raw?.agentInfo?.name, authMethods: Array.isArray(raw?.authMethods) ? raw.authMethods : [] };
}
async function openSession(rpc: RpcProcess): Promise<void> {
  await rpc.request("session/new", { cwd: process.cwd(), mcpServers: [] });
}

/** Check read-only: initialize + session/new; nunca dispara OAuth nem envia session/prompt. */
export async function checkAgySession(): Promise<AgySessionCheck> {
  const runtime = resolveAgyAcpRuntime();
  if (!runtime) return { status: "not_ready", runtime: null, reason: "runtime antigravity-acp standalone não encontrado" };
  const rpc = new RpcProcess(runtime);
  try {
    const info = await initialize(rpc);
    await openSession(rpc);
    return { status: "ready", runtime, ...(info.agentName ? { agentName: info.agentName } : {}) };
  } catch (error) {
    return { status: "not_ready", runtime, reason: error instanceof Error ? error.message : "falha ACP" };
  } finally {
    await rpc.close();
  }
}

/** Login interativo pelo método OAuth oficial anunciado pelo servidor ACP. */
export async function loginAgy(): Promise<AgyLoginResult> {
  const runtime = resolveAgyAcpRuntime();
  if (!runtime) throw new Error("runtime antigravity-acp standalone não encontrado; instale o binário oficial do ACP Registry");
  const rpc = new RpcProcess(runtime);
  try {
    const info = await initialize(rpc);
    const method = info.authMethods.find((item) => item.id === AUTH_METHOD || item.methodId === AUTH_METHOD);
    if (!method) throw new Error("runtime ACP não anunciou oauth-personal; login cancelado");
    await rpc.request("authenticate", { methodId: AUTH_METHOD }, 5 * 60_000);
    await openSession(rpc);
    return { status: "authenticated", runtime, ...(info.agentName ? { agentName: info.agentName } : {}) };
  } finally {
    await rpc.close();
  }
}
