export type { HydroAgentAttachment } from "./attachments.ts";
export { buildAuthoringArchive } from "./authoring-archive.ts";
export type {
	AuthoringEvidence,
	AuthoringSummary,
	HydroAuthoringProject,
	HydroAuthoringReport,
} from "./authoring-project.ts";
export type {
	HydroAiConfigurationController,
	HydroAiConfigurationInput,
	HydroAiConfigurationOptions,
	HydroAiConfigurationSnapshot,
	HydroAiModelOption,
	HydroAiProviderOption,
} from "./configuration.ts";
export { HydroAiConfiguration, HydroAiConfigurationError } from "./configuration.ts";
export type {
	CreateHydroAgentExecutorOptions,
	HydroAgentExecutionInput,
	HydroAgentExecutionOutcome,
	HydroAgentExecutor,
	HydroAgentMetrics,
	HydroAgentModelSettings,
	HydroAgentPhase,
	HydroAgentProgressEvent,
	HydroAgentReadiness,
	HydroConversationMessage,
} from "./executor.ts";
export { buildHydroAuthoringPrompt, createHydroAgentExecutor } from "./executor.ts";
export type {
	HydroProgramLanguage,
	HydroReferenceProgram,
	HydroSandbox,
	HydroSandboxCaseResult,
	HydroSandboxReport,
	HydroSandboxRequest,
	HydroSandboxStatus,
} from "./sandbox.ts";
export { DockerHydroSandbox } from "./sandbox.ts";
export type { HydroAuthoringResourceOptions, HydroAuthoringSessionOptions } from "./session.ts";
export { createHydroAuthoringSession, loadHydroAuthoringResources } from "./session.ts";
export { createHydroAuthoringTools } from "./tools.ts";
export type { BuiltProblemArtifact } from "./workspace.ts";
export {
	buildProblemArtifact,
	problemArtifactDirectory,
	validateProblemArtifact,
} from "./workspace.ts";
