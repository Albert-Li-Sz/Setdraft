import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HYDRO_JUDGE_LIMITS, type HydroJudgeLimits } from "@hydro-problem-make/authoring";
import { ChatService } from "./chat.ts";
import { IdentityStore } from "./identity.ts";
import { ManualProjectStore } from "./manual-projects.ts";
import { createHydroServer } from "./server.ts";
import { acquireServerLock } from "./server-lock.ts";
import { WorkspaceDatabase } from "./workspace-db.ts";

const portValue = Number.parseInt(process.env.PORT ?? "4321", 10);
if (!Number.isSafeInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error("PORT must be 1-65535.");
const judgeLimits: HydroJudgeLimits = {
	maxTestCases: Number(process.env.HYDRO_TESTCASES_MAX ?? DEFAULT_HYDRO_JUDGE_LIMITS.maxTestCases),
	totalTimeLimitMs: Number(process.env.HYDRO_TOTAL_TIME_LIMIT_MS ?? DEFAULT_HYDRO_JUDGE_LIMITS.totalTimeLimitMs),
};
if (!Number.isSafeInteger(judgeLimits.maxTestCases) || judgeLimits.maxTestCases < 1)
	throw new Error("HYDRO_TESTCASES_MAX must be a positive integer.");
if (!Number.isSafeInteger(judgeLimits.totalTimeLimitMs) || judgeLimits.totalTimeLimitMs < 1)
	throw new Error("HYDRO_TOTAL_TIME_LIMIT_MS must be a positive integer.");

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const workspaceRoot = resolve(projectRoot, process.env.HYDRO_WORKSPACE_ROOT ?? ".hydro-problem-make");
const releaseLock = acquireServerLock(workspaceRoot);
process.once("exit", releaseLock);
const identity = new IdentityStore(workspaceRoot);
if (!identity.initialized) console.log(`Setdraft 一次性安装码（24 小时有效）：${identity.rotateSetupToken()}`);
const database = new WorkspaceDatabase(workspaceRoot);
const projects = new ManualProjectStore({
	root: workspaceRoot,
	database,
	image: process.env.HYDRO_SANDBOX_IMAGE,
	judgeLimits,
	maxFileBytes: Number(process.env.HYDRO_CASE_MAX_BYTES ?? 64 * 1024 * 1024),
	maxProjectBytes: Number(process.env.HYDRO_PROJECT_MAX_BYTES ?? 512 * 1024 * 1024),
});
const chat = new ChatService({
	root: workspaceRoot,
	database,
	configPath: process.env.HYDRO_AI_CONFIG_PATH
		? resolve(projectRoot, process.env.HYDRO_AI_CONFIG_PATH)
		: resolve(workspaceRoot, "ai-config.json"),
});
await chat.loadConfiguration();

const server = createHydroServer({
	identity,
	publicOrigin: process.env.HYDRO_PUBLIC_ORIGIN,
	staticRoot: process.env.HYDRO_WEB_ROOT === undefined ? undefined : resolve(process.env.HYDRO_WEB_ROOT),
	projects,
	chat,
});
server.listen(portValue, "127.0.0.1", () => {
	console.log(`Setdraft API listening on http://127.0.0.1:${portValue}`);
	console.log(`AI chat: ${chat.getConfiguration().configured ? "configured" : "not configured"}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.once(signal, () => {
		server.close(() => {
			void server.closeWorkspaces().finally(() => {
				database.db.close();
				identity.close();
				process.exit(0);
			});
		});
		server.closeAllConnections();
	});
