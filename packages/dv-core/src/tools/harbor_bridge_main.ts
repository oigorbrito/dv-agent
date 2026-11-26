/**
 * Entrypoint for the DV↔Harbor stdio bridge.
 *
 * DV_HARBOR_RUN_MODULE must point to a controller-side ESM module exporting
 * runDVTask({ instruction, tools, emitTelemetry }). That module owns model
 * resolution and constructs executeRung() options; this file owns only the
 * protocol lifecycle and remote workspace tools.
 */
import { pathToFileURL } from "node:url";
import { createHarborRemoteWorkspaceTools, emitHarborTelemetry } from "./harbor_remote_tools.ts";

type RunModule = {
  runDVTask: (input: {
    instruction: string;
    tools: ReturnType<typeof createHarborRemoteWorkspaceTools>;
    emitTelemetry: typeof emitHarborTelemetry;
  }) => Promise<void>;
};

async function main(): Promise<void> {
  const modulePath = process.env.DV_HARBOR_RUN_MODULE;
  if (!modulePath) throw new Error("DV_HARBOR_RUN_MODULE must identify a module exporting runDVTask()");
  const loaded = await import(pathToFileURL(modulePath).href) as Partial<RunModule>;
  if (typeof loaded.runDVTask !== "function") {
    throw new Error("DV_HARBOR_RUN_MODULE does not export runDVTask()");
  }
  const instruction = process.env.DV_HARBOR_INSTRUCTION;
  if (!instruction) throw new Error("DV_HARBOR_INSTRUCTION is required");
  await loaded.runDVTask({
    instruction,
    tools: createHarborRemoteWorkspaceTools(),
    emitTelemetry: emitHarborTelemetry,
  });
  process.stdout.write(JSON.stringify({ type: "bridge_done" }) + "\\n");
}

main().catch((error: unknown) => {
  // stdout is reserved for protocol frames.
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
