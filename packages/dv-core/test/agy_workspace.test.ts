// Handlers ACP v1 para filesystem e terminais, exercitados sem provedor ou rede.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { registerAcpWorkspaceHandlers } from "../src/providers/agy/acp_workspace.ts";
import { JsonRpcConnection } from "../src/providers/agy/jsonrpc.ts";

function harness(root: string) {
	const input = new PassThrough();
	const output = new PassThrough();
	output.setEncoding("utf8");
	const connection = new JsonRpcConnection(input, output);
	const handlers = registerAcpWorkspaceHandlers(connection, root, "session-test");
	let nextId = 1;
	let buffer = "";
	const replies = new Map<number, (message: Record<string, unknown>) => void>();
	output.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			const message = JSON.parse(line) as Record<string, unknown>;
			const id = message.id;
			if (typeof id === "number") replies.get(id)?.(message);
			index = buffer.indexOf("\n");
		}
	});
	return {
		async request(method: string, params: Record<string, unknown>) {
			const id = nextId++;
			const reply = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
			input.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { sessionId: "session-test", ...params } })}\n`,
			);
			return reply;
		},
		handlers,
	};
}

test("ACP fs: lê com offset e escreve atomicamente dentro do workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "dv-acp-fs-"));
	try {
		writeFileSync(join(root, "read.txt"), "one\ntwo\nthree\n", "utf8");
		const client = harness(root);
		const read = await client.request("fs/read_text_file", { path: join(root, "read.txt"), line: 2, limit: 1 });
		assert.deepEqual(read.result, { content: "two" });
		const write = await client.request("fs/write_text_file", {
			path: join(root, "nested", "new.txt"),
			content: "safe\n",
		});
		assert.deepEqual(write.result, {});
		assert.equal(readFileSync(join(root, "nested", "new.txt"), "utf8"), "safe\n");
		await client.handlers.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ACP fs: bloqueia traversal absoluto, '..' e junction que sai do workspace", async () => {
	const parent = mkdtempSync(join(tmpdir(), "dv-acp-path-"));
	const root = join(parent, "workspace");
	const outside = join(parent, "outside");
	mkdirSync(root);
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
	try {
		symlinkSync(outside, join(root, "escape"), "junction");
		const client = harness(root);
		for (const path of [
			join(parent, "outside", "secret.txt"),
			join(root, "..", "outside", "secret.txt"),
			join(root, "escape", "secret.txt"),
		]) {
			const reply = await client.request("fs/read_text_file", { path });
			assert.equal(typeof reply.error, "object", `path recusado: ${path}`);
		}
		await client.handlers.close();
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("ACP terminal: executa stub local no cwd confinado, retorna saída e rejeita cwd externo", async () => {
	const parent = mkdtempSync(join(tmpdir(), "dv-acp-terminal-"));
	const root = join(parent, "workspace");
	mkdirSync(root);
	const client = harness(root);
	try {
		const created = await client.request("terminal/create", {
			command: process.execPath,
			args: ["-e", "process.stdout.write(process.cwd())"],
			cwd: root,
			outputByteLimit: 4096,
		});
		const terminalId = (created.result as { terminalId: string }).terminalId;
		const exited = await client.request("terminal/wait_for_exit", { terminalId });
		assert.deepEqual(exited.result, { exitCode: 0, signal: null });
		const output = await client.request("terminal/output", { terminalId });
		assert.equal((output.result as { output: string }).output, root);
		assert.deepEqual((await client.request("terminal/release", { terminalId })).result, {});
		const outsideCwd = await client.request("terminal/create", {
			command: process.execPath,
			args: ["-e", ""],
			cwd: parent,
		});
		assert.equal(typeof outsideCwd.error, "object");
	} finally {
		await client.handlers.close();
		rmSync(parent, { recursive: true, force: true });
	}
});
