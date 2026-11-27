// Login Antigravity via método OAuth anunciado pelo runtime ACP standalone oficial.
import { loginAgy } from "./agy_auth.ts";

const [action, provider, ...extra] = process.argv.slice(2);

if (action === "--help" || action === "-h" || action === undefined) {
  process.stdout.write("Uso: dv auth login agy\n");
} else {
  if (action !== "login" || provider !== "agy" || extra.length > 0) {
    throw new Error("uso inválido; esperado: dv auth login agy");
  }
  const result = await loginAgy();
  process.stdout.write(`${JSON.stringify({ provider: "agy", status: result.status, runtime: result.runtime, ...(result.agentName ? { agent: result.agentName } : {}) }, null, 2)}\n`);
}
