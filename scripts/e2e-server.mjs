import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { ChatService, IdentityStore, ManualProjectStore, createHydroServer } from "../packages/hydro-server/dist/index.js";
import { migrateDatabase } from "../packages/hydro-server/dist/database-schema.js";
import { closeDatabasePools, identifier, registerDatabase } from "../packages/hydro-server/dist/postgres.js";
import { seedRelease } from "./e2e-release.mjs";

// This entry point is exclusively a test harness; controls use the child IPC channel.
const adminUrl = process.env.SETDRAFT_E2E_DATABASE_URL;
if (!adminUrl || !process.send) throw new Error("Run through the Playwright fixtures with a dedicated test database.");
const root = await mkdtemp(join(tmpdir(), "setdraft-e2e-"));
const prefix = `e2e_${randomBytes(8).toString("hex")}_`;
const role = `${prefix}app`;
async function removeTestDatabase() {
	const admin = new Pool({ connectionString: adminUrl, max: 1 });
	try { await admin.query(`DROP SCHEMA IF EXISTS ${identifier(`${prefix}workspace`)} CASCADE; DROP SCHEMA IF EXISTS ${identifier(`${prefix}identity`)} CASCADE; DROP ROLE IF EXISTS ${identifier(role)}`); }
	finally { await admin.end(); }
}
try { await migrateDatabase(adminUrl, role, prefix, process.env.SETDRAFT_E2E_APP_PASSWORD); }
catch {
	try { await removeTestDatabase(); } finally { await rm(root, { recursive: true, force: true }); }
	throw new Error("E2E database initialization failed");
}
const appUrl = new URL(adminUrl);
appUrl.username = role;
appUrl.password = process.env.SETDRAFT_E2E_APP_PASSWORD;
registerDatabase(root, { pool: new Pool({ connectionString: appUrl.toString(), max: 16 }), identitySchema: `${prefix}identity`, workspaceSchema: `${prefix}workspace`, ready: Promise.resolve() });
let clockOffset = 0;
const identity = new IdentityStore(root, () => Date.now() + clockOffset);
const projects = new ManualProjectStore({ root, image: process.env.SETDRAFT_SANDBOX_IMAGE || "setdraft/sandbox:local" });
const failures = new Set();
const pendingAi = new Set();
async function holdAi(signal) {
	await new Promise((resolve, reject) => {
		const resume = () => { pendingAi.delete(resume); signal?.removeEventListener("abort", abort); resolve(); };
		const abort = () => { pendingAi.delete(resume); reject(signal.reason); };
		pendingAi.add(resume);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
const chat = new ChatService({
	root,
	configPath: join(root, "ai-config.json"),
	client: async ({ context, signal, onDelta }) => {
		if (context.systemPrompt?.includes("关键词规划器")) return '["faux public search"]';
		const last = context.messages.at(-1)?.content;
		const text = typeof last === "string" ? last : "";
		if (text.includes("FAUX_FINAL")) { onDelta("临时增量"); return { text: "完整最终正文", finishReason: "length", complete: false }; }
		if (text.includes("FAUX_REFUSAL")) { onDelta("拒绝"); return { text: "模型拒绝文本", finishReason: "refusal", complete: true }; }
		if (text.includes("FAUX_LAYOUT")) {
			const prose = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：这是用于检查长消息阅读位置和行长的固定内容。`).join("\n\n");
			const columns = Array.from({ length: 14 }, (_, index) => `column-${index + 1}`);
			const table = `|${columns.join("|")}|\n|${columns.map(() => "---").join("|")}|\n|${columns.map(() => "sample-long-value").join("|")}|`;
			const body = `${prose}\n\n\`\`\`cpp\nconst char* payload = "${"x".repeat(400)}";\n\`\`\`\n\n${table}\n\n`;
			onDelta(body);
			if (text.includes("FAUX_SLOW")) await holdAi(signal);
			onDelta("LAYOUT_END");
			return { text: `${body}LAYOUT_END` };
		}
		if (text.includes("FAUX_FAIL_ONCE") && !failures.has(text)) { failures.add(text); throw new Error("Deterministic faux failure"); }
		if (text.includes("FAUX_FAIL_ALWAYS")) throw new Error("Deterministic faux failure");
		for (const [index, delta] of ["测试回复：", "**完成**\n\n", "```cpp\nint answer = 42;\n```\n"].entries()) {
			await setTimeout(20, undefined, { signal });
			onDelta(delta);
			if (index === 0 && text.includes("FAUX_SLOW")) await holdAi(signal);
		}
		return { text: "测试回复：**完成**\n\n```cpp\nint answer = 42;\n```\n" };
	},
});
let server;
let port = 0;
async function start() {
	server = await createHydroServer({ identity, projects, chat, staticRoot: resolve("packages/hydro-web/dist") });
	await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
	port = server.address().port;
}
async function stop() {
	if (!server) return;
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	await server.closeWorkspaces();
}
let stopping;
async function cleanup() {
	if (stopping) return stopping;
	stopping = (async () => {
		await stop();
		await closeDatabasePools();
		try { await removeTestDatabase(); }
		finally { await rm(root, { recursive: true, force: true }); }
	})();
	return stopping;
}
try {
	await start();
	process.send({ type: "ready", url: `http://127.0.0.1:${port}`, setupToken: await identity.rotateSetupToken() });
} catch {
	await cleanup();
	throw new Error("E2E server initialization failed");
}
process.on("message", async message => {
	try {
		let result;
		if (message.action === "expire") clockOffset += 8 * 86_400_000;
		else if (message.action === "restart") { await stop(); await start(); }
		else if (message.action === "seed-release") { await identity.getUser(message.payload.userId); result = await seedRelease(root, message.payload.userId); }
		else if (message.action === "release-ai") { for (const resume of pendingAi) resume(); }
		else throw new Error("Unknown fixture action");
		process.send({ type: "ack", id: message.id, result });
	} catch { process.send({ type: "ack", id: message.id, error: "Fixture action failed" }); }
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => void cleanup().finally(() => process.exit(0)));
process.once("disconnect", () => void cleanup().finally(() => process.exit(0)));
