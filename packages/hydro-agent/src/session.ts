import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { HydroAgentAttachment } from "./attachments.ts";
import type { HydroReferenceProgram, HydroSandbox } from "./sandbox.ts";
import { createHydroAuthoringTools } from "./tools.ts";

export interface HydroAuthoringResourceOptions {
	workspaceRoot: string;
	agentDir: string;
	skillPath: string;
}

export interface HydroAuthoringSessionOptions extends HydroAuthoringResourceOptions {
	runId: string;
	modelRuntime?: ModelRuntime;
	sessionManager?: SessionManager;
	sandbox?: HydroSandbox;
	referenceProgram?: HydroReferenceProgram;
	attachments?: HydroAgentAttachment[];
}

export async function loadHydroAuthoringResources(
	options: HydroAuthoringResourceOptions,
): Promise<DefaultResourceLoader> {
	const contract = await readFile(join(dirname(resolve(options.skillPath)), "references/hydro-contract.md"), "utf8");
	const loader = new DefaultResourceLoader({
		cwd: resolve(options.workspaceRoot),
		agentDir: resolve(options.agentDir),
		additionalSkillPaths: [resolve(options.skillPath)],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		skillsOverride: (resources) => ({
			skills: resources.skills.filter((skill) => skill.name === "hydro-problem-authoring"),
			diagnostics: resources.diagnostics,
		}),
		systemPrompt: `You author Hydro programming problems. Reply in Chinese. Treat the current statement as authoritative when old code or metadata conflicts. Call select_hydro_judging once, then stage focused draft sections. A complete update automatically runs quick verification; repair only failed fields. Call finalize_hydro_authoring after quick succeeds. Only request clarification for genuinely missing input/output or interaction semantics. Avoid long analysis and repeated source text. Common release rules:\n\n${contract}`,
	});
	await loader.reload();
	const resources = loader.getSkills();
	const selected: Skill[] = resources.skills.filter((skill) => skill.name === "hydro-problem-authoring");
	if (resources.diagnostics.length > 0 || selected.length !== 1) {
		throw new Error(`Could not load the Hydro authoring Skill: ${JSON.stringify(resources.diagnostics)}`);
	}
	return loader;
}

export async function createHydroAuthoringSession(options: HydroAuthoringSessionOptions) {
	const workspaceRoot = resolve(options.workspaceRoot);
	const resourceLoader = await loadHydroAuthoringResources(options);
	const customTools = createHydroAuthoringTools(workspaceRoot, options.runId, options);
	return createAgentSession({
		cwd: workspaceRoot,
		agentDir: resolve(options.agentDir),
		modelRuntime: options.modelRuntime,
		resourceLoader,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(workspaceRoot),
		tools: customTools.map((tool) => tool.name),
		customTools,
	});
}
