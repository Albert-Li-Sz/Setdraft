import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type HydroProblemSpec,
	isSafeFlatName,
	type ValidationReport,
	validateHydroDirectory,
	writeHydroProblemDirectory,
} from "@hydro-problem-make/authoring";
import type { AuthoringEvidence, AuthoringSummary } from "./authoring-project.ts";
import type { HydroReferenceProgram, HydroSandboxReport } from "./sandbox.ts";

export interface BuiltProblemArtifact {
	directory: string;
	report: ValidationReport;
	verification?: HydroSandboxReport;
	authoring?: AuthoringSummary;
}

export async function saveAuthoringEvidence(
	workspaceRoot: string,
	runId: string,
	evidence: AuthoringEvidence,
): Promise<void> {
	validateArtifactName(runId, "runId");
	validateArtifactName(evidence.summary.verificationId, "verificationId");
	const segments = ["artifacts", runId, "authoring", evidence.summary.verificationId];
	await assertSafeDirectoryChain(resolve(workspaceRoot), segments);
	const directory = join(resolve(workspaceRoot), ...segments);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence));
}

export async function loadAuthoringEvidence(
	workspaceRoot: string,
	runId: string,
	verificationId: string,
): Promise<AuthoringEvidence> {
	validateArtifactName(runId, "runId");
	validateArtifactName(verificationId, "verificationId");
	const segments = ["artifacts", runId, "authoring", verificationId];
	await assertSafeDirectoryChain(resolve(workspaceRoot), segments);
	return JSON.parse(
		await readFile(join(resolve(workspaceRoot), ...segments, "evidence.json"), "utf8"),
	) as AuthoringEvidence;
}

export async function saveReferenceEvidence(
	workspaceRoot: string,
	runId: string,
	program: HydroReferenceProgram,
	report: HydroSandboxReport,
): Promise<void> {
	validateArtifactName(runId, "runId");
	const root = resolve(workspaceRoot);
	await assertSafeDirectoryChain(root, ["artifacts", runId, "authoring"]);
	const directory = join(root, "artifacts", runId, "authoring");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "reference.json"), JSON.stringify(program, null, 2));
	await writeFile(join(directory, "sandbox-report.json"), JSON.stringify(report, null, 2));
}

async function assertSafeDirectoryChain(root: string, segments: readonly string[]): Promise<void> {
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink() || !stats.isDirectory())
				throw new Error(`Unsafe artifact path component: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

function validateArtifactName(value: string, label: string): void {
	if (!isSafeFlatName(value)) throw new Error(`${label} must be a flat ASCII name.`);
}

export function problemArtifactDirectory(workspaceRoot: string, runId: string, slug: string): string {
	validateArtifactName(runId, "runId");
	validateArtifactName(slug, "slug");
	return join(resolve(workspaceRoot), "artifacts", runId, "hydro", slug);
}

export async function buildProblemArtifact(
	workspaceRoot: string,
	runId: string,
	spec: HydroProblemSpec,
): Promise<BuiltProblemArtifact> {
	validateArtifactName(runId, "runId");
	const root = resolve(workspaceRoot);
	await mkdir(root, { recursive: true });
	const rootStats = await lstat(root);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
		throw new Error("Workspace root must be a real directory.");
	await assertSafeDirectoryChain(root, ["artifacts", runId, "hydro"]);
	const hydroRoot = join(root, "artifacts", runId, "hydro");
	const directory = await writeHydroProblemDirectory(spec, hydroRoot);
	try {
		const report = await validateHydroDirectory(directory);
		if (!report.valid)
			throw new Error(`Generated Hydro artifact failed validation: ${JSON.stringify(report.issues)}`);
		return { directory, report };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export async function validateProblemArtifact(
	workspaceRoot: string,
	runId: string,
	slug: string,
): Promise<ValidationReport> {
	return validateHydroDirectory(problemArtifactDirectory(workspaceRoot, runId, slug));
}
