import {
	type DraftRevision,
	type DraftRevisionSummary,
	type ManualProject,
	readProjectSnapshot,
} from "@setdraft/contracts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";
import { hashFile } from "./project-files.ts";
import type { WorkspaceFile } from "./workspace-db.ts";

const historyLimit = 40;
interface SavedDraft extends DraftRevision {
	files: Array<{ origin: "manual" | "generated" | "pdf"; name: string; hash: string; size: number }>;
}

/** Saved revisions pin immutable blobs, including files removed from the current draft. */
export class DraftHistory {
	private readonly projects: ManualProjectStore;
	constructor(projects: ManualProjectStore) {
		this.projects = projects;
	}
	private get database() {
		return this.projects.database;
	}
	private summary({ project: _project, files: _files, ...summary }: SavedDraft): DraftRevisionSummary {
		return summary;
	}
	async capture(project: ManualProject): Promise<void> {
		const id = `${project.id}:${project.revision}`;
		if (await this.database.get("draft-history", id)) return;
		const files: SavedDraft["files"] = [];
		for (const origin of ["manual", "generated", "pdf"] as const)
			for (const entry of await this.database.fileEntries(origin, project.id)) files.push({ origin, ...entry });
		const snapshot = { ...project, ...(await this.projects.caseList(project, false)) };
		const saved: SavedDraft = {
			id,
			projectId: project.id,
			revision: project.revision,
			savedAt: project.updatedAt,
			title: project.title,
			caseCount: snapshot.cases.length,
			project: snapshot,
			files,
		};
		await this.database.put("draft-history", id, saved, -1);
		await this.database.sql.execute(
			"INSERT INTO files(owner_kind,owner_id,name,hash,size) SELECT 'draft-file',$1,owner_kind || '/' || name,hash,size FROM files WHERE owner_id=$2 AND owner_kind IN ('manual','generated','pdf')",
			[id, project.id],
		);
		const rows = await this.database.sql.all<{ id: string }>(
			"SELECT id FROM documents WHERE kind='draft-history' AND body->>'projectId'=$1 ORDER BY (body->>'revision')::bigint DESC",
			[project.id],
		);
		// Bound snapshots and retained data independently. Shared blobs are counted only once.
		for (let length = rows.length; length > 1; length--) {
			const usage = await this.database.sql.one<{ bytes: string; metadata: string }>(
				`SELECT (SELECT coalesce(sum(size),0) FROM (SELECT max(f.size) AS size FROM files f JOIN documents d ON d.kind='draft-history' AND d.id=f.owner_id WHERE f.owner_kind='draft-file' AND d.body->>'projectId'=$1 GROUP BY f.hash) blobs)::text AS bytes,
				(SELECT coalesce(sum(pg_column_size(body)),0) FROM documents WHERE kind='draft-history' AND body->>'projectId'=$1)::text AS metadata`,
				[project.id],
			);
			if (
				length <= historyLimit &&
				Number(usage?.bytes) <= this.projects.maxProjectBytes &&
				Number(usage?.metadata) <= 32 * 1024 * 1024
			)
				break;
			const oldest = rows[length - 1].id;
			await this.database.removeOwnerFiles("draft-file", oldest);
			await this.database.delete("draft-history", oldest);
		}
	}
	async list(projectId: string): Promise<DraftRevisionSummary[]> {
		return this.database.transaction(async () => {
			const current = await this.projects.snapshot(projectId);
			const rows = await this.database.sql.all<{ body: SavedDraft }>(
				"SELECT body FROM documents WHERE kind='draft-history' AND body->>'projectId'=$1 ORDER BY (body->>'revision')::bigint DESC",
				[projectId],
			);
			return [
				{
					id: `${projectId}:${current.revision}`,
					projectId,
					revision: current.revision,
					savedAt: current.updatedAt,
					title: current.title,
					caseCount: current.cases.length,
					current: true,
				},
				...rows.filter(({ body }) => body.revision !== current.revision).map(({ body }) => this.summary(body)),
			];
		});
	}
	async get(projectId: string, revision: number): Promise<DraftRevision> {
		return this.database.transaction(async () => {
			const current = await this.projects.snapshot(projectId);
			if (!Number.isSafeInteger(revision) || revision < 0) throw new ManualProjectError("草稿版本无效。", 422);
			if (current.revision === revision)
				return {
					id: `${projectId}:${revision}`,
					projectId,
					revision,
					savedAt: current.updatedAt,
					title: current.title,
					caseCount: current.cases.length,
					current: true,
					project: current,
				};
			const saved = await this.database.get<SavedDraft>("draft-history", `${projectId}:${revision}`);
			if (!saved || saved.projectId !== projectId)
				throw new ManualProjectError("草稿历史不存在或已超出保留范围。", 404);
			return { ...this.summary(saved), project: readProjectSnapshot(saved.project) };
		});
	}
	async restore(
		projectId: string,
		revision: number,
		expectedRevision: unknown,
		assertAccess: () => Promise<void>,
	): Promise<DraftRevision["project"]> {
		if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
			throw new ManualProjectError("请提供当前题目版本。", 422);
		const unlock = await this.projects.lock(projectId);
		try {
			const current = await this.projects.load(projectId);
			if (current.revision !== expectedRevision)
				throw new ManualProjectError(
					"题目版本已变化，请比较最新内容。",
					409,
					await this.projects.snapshot(projectId),
				);
			const saved = await this.get(projectId, revision);
			if (saved.current) return await this.projects.snapshot(projectId);
			const stored = await this.database.get<SavedDraft>("draft-history", saved.id);
			if (!stored || saved.project.scoringMode !== current.scoringMode)
				throw new ManualProjectError("草稿历史无效。", 422);
			const files: WorkspaceFile[] = [];
			for (const entry of stored.files) {
				const path = await this.database.filePath("draft-file", saved.id, `${entry.origin}/${entry.name}`);
				if (!path || (await hashFile(path)) !== entry.hash)
					throw new ManualProjectError("草稿历史数据文件缺失或损坏。", 422);
				files.push({ ownerKind: entry.origin, ownerId: projectId, name: entry.name, source: { path } });
			}
			const { cases: _cases, orphanOutputs: _orphans, dataIssues: _issues, ...content } = saved.project;
			const restored: ManualProject = {
				...content,
				id: projectId,
				createdAt: current.createdAt,
				updatedAt: new Date().toISOString(),
				revision: current.revision + 1,
				latestReleaseId: current.latestReleaseId,
				lastReport: undefined,
			};
			for (const key of Object.keys(current)) if (!(key in restored)) Reflect.deleteProperty(current, key);
			Object.assign(current, restored);
			await this.database.commitFiles(
				files,
				async () => {
					await assertAccess();
					// Retention may have removed this revision while files were staged.
					if (!(await this.database.get("draft-history", saved.id)))
						throw new ManualProjectError("草稿历史已过期，请刷新。", 409);
					await this.projects.save(current);
				},
				["manual", "generated", "pdf"].map((ownerKind) => ({ ownerKind, ownerId: projectId })),
			);
			return await this.projects.snapshot(projectId);
		} finally {
			unlock();
		}
	}
	async delete(projectId: string): Promise<void> {
		for (const { id } of await this.database.sql.all<{ id: string }>(
			"SELECT id FROM documents WHERE kind='draft-history' AND body->>'projectId'=$1",
			[projectId],
		)) {
			await this.database.removeOwnerFiles("draft-file", id);
			await this.database.delete("draft-history", id);
		}
	}
}
