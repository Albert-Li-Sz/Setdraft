import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ManualProgram, ManualProject, ManualRelease } from "@setdraft/contracts";
import { exportContractVersion, requiresReverification } from "@setdraft/contracts";
import { assertReleasesUnreferenced } from "./contest-references.ts";
import { writeDomjudgeProblemArchive } from "./domjudge-export.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { exportFileName } from "./export-contract.ts";
import { writeLegacyProblemExport } from "./legacy-exports.ts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";
import { SandboxCleanupError } from "./sandbox-runtime.ts";

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
		const stored = await this.projects.database.get<ManualRelease>("release", id);
		if (!stored) throw new ManualProjectError("发布记录不存在。", 404);
		return stored;
	}

	async listReleases(): Promise<ManualRelease[]> {
		return (await this.projects.database.list<ManualRelease>("release")).sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	async rename(id: string, value: unknown): Promise<ManualRelease> {
		return this.projects.database.transaction(async () => {
			const release = await this.release(id);
			release.name = releaseName(value);
			await this.projects.database.put("release", id, release);
			return release;
		});
	}

	async releaseReference(id: string): Promise<ManualProgram> {
		await this.release(id);
		const snapshot = JSON.parse(
			await readFile(join(this.projects.releaseDirectory(id), "source", "project.json"), "utf8"),
		) as ManualProject;
		return snapshot.reference;
	}

	async exportDomjudge(
		id: string,
		context?: ExecutionContext,
		statement?: { pdfPath: string; archivePath: string },
	): Promise<{ path: string; size: number; name: string }> {
		return (context?.observability ?? this.projects.observability).startSpan(
			{ name: "release.export", attributes: { "export.format": "domjudge" } },
			() => this.exportDomjudgeImpl(id, context, statement),
		);
	}
	private async exportDomjudgeImpl(
		id: string,
		context?: ExecutionContext,
		statement?: { pdfPath: string; archivePath: string },
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		if (requiresReverification(release)) throw new ManualProjectError("该历史版本须重新验证并发布。", 422);
		try {
			await writeDomjudgeProblemArchive(this.projects.releaseDirectory(id), release, this.projects.image, {
				signal: context?.signal,
				taskId: context?.id,
				containerName: context ? `setdraft-task-${context.id}` : undefined,
				...statement,
			});
		} catch (error) {
			if (error instanceof SandboxCleanupError) throw error;
			throw new ManualProjectError(error instanceof Error ? error.message : "DOMjudge 导出失败。", 422);
		}
		if (statement)
			return {
				path: statement.archivePath,
				size: (await stat(statement.archivePath)).size,
				name: `${release.slug}.domjudge.zip`,
			};
		await this.indexExport(id, "domjudge");
		return await this.releaseFile(id, "domjudge");
	}

	async exportLegacy(id: string, format: "fps" | "qduoj"): Promise<{ path: string; size: number; name: string }> {
		return this.projects.observability.startSpan(
			{ name: "release.export", attributes: { "export.format": format } },
			() => this.exportLegacyImpl(id, format),
		);
	}
	private async exportLegacyImpl(
		id: string,
		format: "fps" | "qduoj",
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		if (requiresReverification(release)) throw new ManualProjectError("该历史版本须重新验证并发布。", 422);
		try {
			await writeLegacyProblemExport(this.projects.releaseDirectory(id), release, format);
		} catch (error) {
			throw new ManualProjectError(error instanceof Error ? error.message : "题目格式导出失败。", 422);
		}
		await this.indexExport(id, format);
		return await this.releaseFile(id, format);
	}

	private async indexExport(id: string, format: "domjudge" | "fps" | "qduoj"): Promise<void> {
		const name = exportFileName(format);
		await this.projects.database.commitFiles(
			[
				{
					ownerKind: "release-file",
					ownerId: id,
					name,
					source: { path: join(this.projects.releaseDirectory(id), name) },
				},
			],
			async () => {
				const release = await this.release(id);
				release.exports = {
					...release.exports,
					[format]: { contractVersion: exportContractVersion, createdAt: new Date().toISOString() },
				};
				await this.projects.database.put("release", id, release);
			},
		);
	}

	async releaseFile(
		id: string,
		kind: "hydro" | "source" | "domjudge" | "fps" | "qduoj",
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		if (["domjudge", "fps", "qduoj"].includes(kind) && requiresReverification(release))
			throw new ManualProjectError("该历史版本使用旧判分契约，请从源快照重新验证并发布。", 422);
		const fileName = kind === "domjudge" || kind === "fps" || kind === "qduoj" ? exportFileName(kind) : `${kind}.zip`;
		const path =
			(await this.projects.database.filePath("release-file", id, fileName)) ??
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
		await this.projects.database.transaction(async () => {
			await assertReleasesUnreferenced(this.projects.database, [id]);
			if (
				await this.projects.database.sql.one(
					"SELECT 1 FROM tasks WHERE resource=$1 AND state IN ('queued','running')",
					[`release:${id}:domjudge`],
				)
			)
				throw new ManualProjectError("发布包正在导出，请等待完成或取消任务。", 409);
			await this.projects.assertNotBusy(release.projectId);
			await this.projects.database.delete("release", id);
			await this.projects.database.removeOwnerFiles("release-file", id);
			const project = (await this.projects.database.get<ManualProject>("project", release.projectId))
				? await this.projects.load(release.projectId)
				: undefined;
			if (project?.latestReleaseId === id) {
				project.latestReleaseId = (await this.projects.database.list<ManualRelease>("release"))
					.filter((item) => item.projectId === project.id)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
				await this.projects.save(project);
			}
		});
		await rm(this.projects.releaseDirectory(id), { recursive: true, force: true });
		await this.projects.database.pruneBlobs();
	}
}
