import { resolve } from "node:path";
export function workspaceRoot(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): string {
	return resolve(projectRoot, environment.SETDRAFT_WORKSPACE_ROOT || ".setdraft");
}
