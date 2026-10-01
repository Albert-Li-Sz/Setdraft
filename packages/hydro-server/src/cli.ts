import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HYDRO_JUDGE_LIMITS, type HydroJudgeLimits } from "@setdraft/authoring";
import { ChatService } from "./chat.ts";
import { workspaceRoot as resolveWorkspaceRoot } from "./environment.ts";
import { IdentityStore } from "./identity.ts";
import { ManualProjectStore } from "./manual-projects.ts";
import { createObservability } from "./observability.ts";
import { acquireApplicationLease, closeDatabasePools } from "./postgres.ts";
import { createHydroServer } from "./server.ts";
import { acquireServerLock } from "./server-lock.ts";
import { WorkspaceDatabase } from "./workspace-db.ts";

const portValue = Number.parseInt(process.env.PORT ?? "4321", 10);
if (!Number.isSafeInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error("PORT must be 1-65535.");
const host = process.env.SETDRAFT_HOST || "0.0.0.0";
if (!["0.0.0.0", "127.0.0.1"].includes(host)) throw new Error("SETDRAFT_HOST must be 0.0.0.0 or 127.0.0.1.");
const judgeLimits: HydroJudgeLimits = {
	maxTestCases: Number(process.env.SETDRAFT_TESTCASES_MAX ?? DEFAULT_HYDRO_JUDGE_LIMITS.maxTestCases),
	totalTimeLimitMs: Number(process.env.SETDRAFT_TOTAL_TIME_LIMIT_MS ?? DEFAULT_HYDRO_JUDGE_LIMITS.totalTimeLimitMs),
};
if (!Number.isSafeInteger(judgeLimits.maxTestCases) || judgeLimits.maxTestCases < 1)
	throw new Error("SETDRAFT_TESTCASES_MAX must be a positive integer.");
if (!Number.isSafeInteger(judgeLimits.totalTimeLimitMs) || judgeLimits.totalTimeLimitMs < 1)
	throw new Error("SETDRAFT_TOTAL_TIME_LIMIT_MS must be a positive integer.");

const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const workspaceRoot = resolveWorkspaceRoot(projectRoot);
const releaseLock = process.env.SETDRAFT_CONTAINER_LOCKED === "1" ? () => {} : acquireServerLock(workspaceRoot);
process.once("exit", releaseLock);
const releaseDatabaseLease = await acquireApplicationLease(workspaceRoot);
const identity = new IdentityStore(workspaceRoot);
if (!(await identity.isInitialized()))
	console.log(`Setdraft 一次性安装码（24 小时有效）：${await identity.rotateSetupToken()}`);
const database = new WorkspaceDatabase(workspaceRoot);
const observability = createObservability();
const projects = new ManualProjectStore({
	root: workspaceRoot,
	database,
	image: process.env.SETDRAFT_SANDBOX_IMAGE,
	judgeLimits,
	maxFileBytes: Number(process.env.SETDRAFT_CASE_MAX_BYTES ?? 64 * 1024 * 1024),
	maxProjectBytes: Number(process.env.SETDRAFT_PROJECT_MAX_BYTES ?? 512 * 1024 * 1024),
	observability,
});
const chat = new ChatService({
	root: workspaceRoot,
	observability,
	database,
	configPath: process.env.SETDRAFT_AI_CONFIG_PATH
		? resolve(projectRoot, process.env.SETDRAFT_AI_CONFIG_PATH)
		: resolve(workspaceRoot, "ai-config.json"),
});
await chat.loadConfiguration();

const server = await createHydroServer({
	identity,
	publicOrigin: process.env.SETDRAFT_PUBLIC_ORIGIN,
	staticRoot: process.env.SETDRAFT_WEB_ROOT === undefined ? undefined : resolve(process.env.SETDRAFT_WEB_ROOT),
	projects,
	chat,
	observability,
});
server.listen(portValue, host, () => {
	console.log(`Setdraft Web/API listening on http://${host}:${portValue}`);
	console.log(`AI chat: ${chat.getConfiguration().configured ? "configured" : "not configured"}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.once(signal, () => {
		server.close(() => {
			void server.closeWorkspaces().finally(async () => {
				await releaseDatabaseLease();
				await closeDatabasePools();
				await observability.shutdown();
				identity.close();
				process.exit(0);
			});
		});
		server.closeAllConnections();
	});
