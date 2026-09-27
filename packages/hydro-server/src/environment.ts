import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** New names win; old deployments keep their data and configuration during upgrades. */
export function migrateEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
	for (const [key, value] of Object.entries(environment)) {
		if (key.startsWith("HYDRO_")) environment[`SETDRAFT_${key.slice(6)}`] ??= value;
	}
}

export function workspaceRoot(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): string {
	migrateEnvironment(environment);
	return resolve(
		projectRoot,
		environment.SETDRAFT_WORKSPACE_ROOT ||
			(existsSync(resolve(projectRoot, ".setdraft")) || !existsSync(resolve(projectRoot, ".hydro-problem-make"))
				? ".setdraft"
				: ".hydro-problem-make"),
	);
}
