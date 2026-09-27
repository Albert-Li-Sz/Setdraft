import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ManualProgram, ManualProject, ManualRelease } from "@hydro-problem-make/contracts";
import { writeDomjudgeProblemArchive } from "./domjudge-export.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { writeLegacyProblemExport } from "./legacy-exports.ts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";

export function releaseName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 80)
		throw new ManualProjectError("发布包名称须为 1–80 个字符。", 422);
	return value.trim();
}

/** Reads immutable releases and derives exports from their saved source, never the live draft. */
export class ReleaseStore {
	private readonly projects: ManualProjectStore;
	constructor(projects: ManualProjectStore) {
		this.projects = projects;
	}
	async release(id: string): Promise<ManualRelease> {
		this.projects.releaseDirectory(id);
		const stored = this.projects.database.get<ManualRelease>("release", id);
		if (!stored) throw new ManualProjectError("发布记录不存在。", 404);
		return stored;
	}

	async listReleases(): Promise<ManualRelease[]> {
		return this.projects.database
			.list<ManualRelease>("release")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async rename(id: string, value: unknown): Promise<ManualRelease> {
		const release = await this.release(id);
		release.name = releaseName(value);
		this.projects.database.put("release", id, release);
		return release;
	}

	async releaseReference(id: string): Promise<ManualProgram> {
		await this.release(id);
		const snapshot = JSON.parse(
			await readFile(join(this.projects.releaseDirectory(id), "source", "project.json"), "utf8"),
		) as ManualProject;
		return snapshot.reference;
	}

	async exportDomjudge(id: string, context?: ExecutionContext): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		try {
			await writeDomjudgeProblemArchive(this.projects.releaseDirectory(id), release, this.projects.image, {
				signal: context?.signal,
				containerName: context ? `hydro-task-${context.id}-checker` : undefined,
			});
		} catch (error) {
			throw new ManualProjectError(error instanceof Error ? error.message : "DOMjudge 导出失败。", 422);
		}
		await this.projects.database.indexFile(
			"release-file",
			id,
			"domjudge.zip",
			join(this.projects.releaseDirectory(id), "domjudge.zip"),
		);
		return this.releaseFile(id, "domjudge");
	}

	async exportLegacy(id: string, format: "fps" | "qduoj"): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		try {
			await writeLegacyProblemExport(this.projects.releaseDirectory(id), release, format);
		} catch (error) {
			throw new ManualProjectError(error instanceof Error ? error.message : "题目格式导出失败。", 422);
		}
		await this.projects.database.indexFile(
			"release-file",
			id,
			`${format}.${format === "fps" ? "xml" : "zip"}`,
			join(this.projects.releaseDirectory(id), `${format}.${format === "fps" ? "xml" : "zip"}`),
		);
		return this.releaseFile(id, format);
	}

	async releaseFile(
		id: string,
		kind: "hydro" | "source" | "domjudge" | "fps" | "qduoj",
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		const fileName = `${kind}.${kind === "fps" ? "xml" : "zip"}`;
		const path =
			this.projects.database.filePath("release-file", id, fileName) ??
			join(this.projects.releaseDirectory(id), fileName);
		let size: number;
		try {
			size = (await stat(path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError("该格式尚未导出。", 404);
			throw error;
		}
		return {
			path,
			size,
			name: `${release.slug}.${kind === "source" ? "authoring" : kind}.${kind === "fps" ? "xml" : "zip"}`,
		};
	}

	async deleteRelease(id: string): Promise<void> {
		const release = await this.release(id);
		this.projects.database.transaction(() => {
			this.projects.assertNotBusy(release.projectId);
			this.projects.database.delete("release", id);
			this.projects.database.removeOwnerFiles("release-file", id);
			const project = this.projects.database.get<ManualProject>("project", release.projectId)
				? this.projects.load(release.projectId)
				: undefined;
			if (project?.latestReleaseId === id) {
				project.latestReleaseId = this.projects.database
					.list<ManualRelease>("release")
					.filter((item) => item.projectId === project.id)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
				this.projects.save(project);
			}
		});
		await rm(this.projects.releaseDirectory(id), { recursive: true, force: true });
		await this.projects.database.pruneBlobs();
	}
}
