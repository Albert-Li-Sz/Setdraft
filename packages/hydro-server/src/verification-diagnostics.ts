import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeStoredArchiveFromFiles } from "@setdraft/authoring";
import type { OutputDifference, VerificationRun } from "@setdraft/contracts";
import { copySandboxFile } from "./sandbox-files.ts";
import type { WorkspaceFile } from "./workspace-db.ts";

export async function readTextPreview(path: string, limit = 8000): Promise<string> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(limit);
		const { bytesRead } = await file.read(buffer, 0, limit, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

/** Copy only flat diagnostic directories, after their containers have stopped. */
export async function collectRunDiagnostics(
	stage: string,
	run: VerificationRun,
	maxBytes: number,
	totalBytes: number,
): Promise<WorkspaceFile[]> {
	const destination = join(stage, "diagnostic-export");
	await mkdir(destination, { recursive: true });
	const budget = { remainingBytes: totalBytes };
	const archive = new Map<string, string>();
	const manifest = new Map<string, string>();
	const files: WorkspaceFile[] = [];
	for (const directory of ["logs", "outputs", "answers", "cases"]) {
		const entries = await readdir(join(stage, directory), { withFileTypes: true }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		if (entries.length > 50000) throw new Error("诊断文件数量超过上限。");
		await mkdir(join(destination, directory), { recursive: true });
		for (const entry of entries) {
			if (!entry.isFile() || !/^[A-Za-z0-9_.:-]+$/u.test(entry.name)) continue;
			const name = `${directory}/${entry.name}`;
			const path = join(destination, name);
			await copySandboxFile(stage, name, path, maxBytes, budget);
			// Number every leaf so platform-safe names cannot collide after replacing ':' in case IDs.
			const archived = `${directory}/${manifest.size}-${entry.name.replaceAll(":", "-")}`;
			manifest.set(name, archived);
			archive.set(archived, path);
			files.push({ ownerKind: "verification-file", ownerId: run.id, name: `diagnostics/${name}`, source: { path } });
		}
	}
	for (const cell of [...(run.matrix?.cells ?? []), ...(run.stress?.cells ?? [])]) {
		if (!cell.artifacts) continue;
		cell.artifacts = {
			output: manifest.has(cell.artifacts.output ?? "") ? cell.artifacts.output : undefined,
			expected: manifest.has(cell.artifacts.expected ?? "") ? cell.artifacts.expected : undefined,
			logs: cell.artifacts.logs.filter((path) => manifest.has(path)),
		};
	}
	await writeFile(join(destination, "run.json"), JSON.stringify(run, null, 2));
	archive.set("run.json", join(destination, "run.json"));
	await writeFile(join(destination, "manifest.json"), JSON.stringify(Object.fromEntries(manifest), null, 2));
	archive.set("manifest.json", join(destination, "manifest.json"));
	await writeStoredArchiveFromFiles(join(destination, "diagnostics.zip"), "setdraft-diagnostics", archive);
	files.push({
		ownerKind: "verification-file",
		ownerId: run.id,
		name: "diagnostics.zip",
		source: { path: join(destination, "diagnostics.zip") },
	});
	return files;
}

/** Exact textual difference for diagnosis only; Checker/Interactor remains authoritative. */
export function firstOutputDifference(actual: string, expected: string): OutputDifference | undefined {
	let index = 0;
	while (index < actual.length && index < expected.length && actual[index] === expected[index]) index++;
	if (index === actual.length && index === expected.length) return undefined;
	// Do not split a surrogate pair when highlighting a differing character.
	if (index && /[\uD800-\uDBFF]/u.test(actual[index - 1])) index--;
	const prefix = actual.slice(0, index);
	const line = prefix.split("\n").length;
	const column = [...prefix.slice(prefix.lastIndexOf("\n") + 1)].length + 1;
	const fragment = (text: string) => {
		const focus = String.fromCodePoint(text.codePointAt(index) ?? 0);
		return {
			before: text.slice(Math.max(text.lastIndexOf("\n", index - 1) + 1, index - 120), index),
			focus: index < text.length ? focus : "",
			after: text.slice(index + focus.length, index + focus.length + 120).split("\n")[0],
		};
	};
	return { line, column, actual: fragment(actual), expected: fragment(expected) };
}

/** Coalesce progress writes and drain them before committing a terminal state. */
export class RunCheckpoints {
	private timer?: NodeJS.Timeout;
	private pending: Promise<void> = Promise.resolve();
	private failure?: unknown;
	private dirty = false;
	private stopped = false;
	private readonly write: () => Promise<void>;
	constructor(write: () => Promise<void>) {
		this.write = write;
	}
	schedule(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.pending = this.pending
				.then(async () => {
					if (!this.dirty || this.failure) return;
					this.dirty = false;
					await this.write();
				})
				.catch((error: unknown) => {
					this.failure = error;
				});
		}, 400);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		await this.pending;
		if (this.failure) throw this.failure;
	}
}
