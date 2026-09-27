import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFlatName } from "@hydro-problem-make/authoring";
import { isProjectSnapshot, type ManualProjectSnapshot } from "@hydro-problem-make/contracts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";
import { hashFile } from "./project-files.ts";
import type { WorkspaceFile } from "./workspace-db.ts";

function checkRevision(project: ManualProjectSnapshot, expected: unknown): void {
	if (!Number.isSafeInteger(expected) || Number(expected) < 0)
		throw new ManualProjectError("请提供当前题目版本。", 422);
	if (project.revision !== expected)
		throw new ManualProjectError("题目版本已变化，请检查最新内容后重试。", 409, project);
}

/** Copy content only. Recipient ownership, identity and history are always created afresh. */
export async function copyProject(
	source: ManualProjectStore,
	id: string,
	target: ManualProjectStore,
	expectedRevision: unknown,
	assertAccess: () => void = () => {},
): Promise<ManualProjectSnapshot> {
	const unlock = source.lock(id);
	try {
		const snapshot = source.snapshot(id);
		checkRevision(snapshot, expectedRevision);
		const version = source.database.version("project", id);
		const { cases: _cases, orphanOutputs: _orphans, ...content } = snapshot;
		const newId = randomUUID();
		const now = new Date().toISOString();
		const project = {
			...content,
			id: newId,
			revision: 0,
			createdAt: now,
			updatedAt: now,
			latestReleaseId: undefined,
			lastReport: undefined,
		};
		const files: WorkspaceFile[] = [];
		for (const kind of ["manual", "generated"] as const) {
			for (const file of source.database.fileEntries(kind, id)) {
				if (file.size > target.maxFileBytes) throw new ManualProjectError("测试数据超过接收工作区限制。", 413);
				files.push({
					ownerKind: kind,
					ownerId: newId,
					name: file.name,
					source: { path: source.dataFile(id, kind, file.name) },
				});
			}
		}
		if (source.projectDataBytes(id) > target.maxProjectBytes)
			throw new ManualProjectError("测试数据超过接收工作区限制。", 413);
		if (project.domjudgePdf)
			files.push({
				ownerKind: "pdf",
				ownerId: newId,
				name: "problem.pdf",
				source: { path: (await source.domjudgePdfFile(id)).path },
			});
		await mkdir(join(target.projectDirectory(newId), "manual"), { recursive: true });
		await target.database.commitFiles(files, () => {
			assertAccess();
			target.assertNotBusy(newId);
			if (version !== source.database.version("project", id))
				throw new ManualProjectError("题目版本已变化，请重试复制。", 409);
			target.database.put("project", newId, project, -1);
		});
		return target.snapshot(newId);
	} finally {
		unlock();
	}
}

/** Restore the source snapshot, not a generated judge export. All replacements commit atomically. */
export async function restoreProject(
	projects: ManualProjectStore,
	id: string,
	releaseId: string,
	expectedRevision: unknown,
	assertAccess: () => void = () => {},
): Promise<ManualProjectSnapshot> {
	const release = await projects.releases.release(releaseId);
	if (release.projectId !== id) throw new ManualProjectError("发布包不存在。", 404);
	const unlock = projects.lock(id);
	try {
		checkRevision(projects.snapshot(id), expectedRevision);
		const current = projects.load(id);
		const root = join(projects.releaseDirectory(releaseId), "source");
		const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
			projectId?: unknown;
			projectHash?: unknown;
			files?: Record<string, unknown>;
			cases?: Array<{ origin: string; inputFile: string }>;
		};
		if (
			manifest.projectId !== id ||
			manifest.projectHash !== release.projectHash ||
			!manifest.files ||
			typeof manifest.files !== "object" ||
			!Array.isArray(manifest.cases) ||
			manifest.cases.length !== release.report.caseCount
		)
			throw new ManualProjectError("发布包源文件不完整，无法回退。", 422);
		const checked = async (name: string): Promise<string> => {
			const path = join(root, name);
			if (typeof manifest.files?.[name] !== "string" || (await hashFile(path)) !== manifest.files[name])
				throw new ManualProjectError("发布包源文件校验失败，无法回退。", 422);
			return path;
		};
		const raw: unknown = JSON.parse(await readFile(await checked("project.json"), "utf8"));
		const record =
			typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
		const candidate = record
			? {
					...record,
					scoringMode: record.scoringMode ?? current.scoringMode,
					generatorStandard: record.generatorStandard ?? "cpp17",
					checkerStandard: record.checkerStandard ?? "cpp17",
					validatorStandard: record.validatorStandard ?? "cpp17",
					cases: [],
					orphanOutputs: [],
				}
			: raw;
		if (
			!isProjectSnapshot(candidate) ||
			candidate.id !== id ||
			candidate.revision !== release.revision ||
			candidate.scoringMode !== current.scoringMode
		)
			throw new ManualProjectError("发布包题目快照无效，无法回退。", 422);
		for (const item of manifest.cases ?? []) {
			if (
				!item ||
				!["manual", "generated"].includes(item.origin) ||
				typeof item.inputFile !== "string" ||
				!isSafeFlatName(item.inputFile) ||
				!manifest.files[`data/${item.origin}/${item.inputFile}`]
			)
				throw new ManualProjectError("发布包源文件不完整，无法回退。", 422);
		}
		const files: WorkspaceFile[] = [];
		for (const name of Object.keys(manifest.files)) {
			const match = /^data\/(manual|generated)\/([^/]+)$/u.exec(name);
			if (!match) continue;
			if (!isSafeFlatName(match[2]) || !/\.(in|out|ans)$/u.test(match[2]))
				throw new ManualProjectError("发布包测试文件名无效。", 422);
			files.push({ ownerKind: match[1], ownerId: id, name: match[2], source: { path: await checked(name) } });
		}
		if (candidate.domjudgePdf)
			files.push({
				ownerKind: "pdf",
				ownerId: id,
				name: "problem.pdf",
				source: { path: await checked("problem.pdf") },
			});
		const { cases: _cases, orphanOutputs: _orphans, ...content } = candidate;
		Object.assign(current, content, {
			id,
			createdAt: current.createdAt,
			updatedAt: new Date().toISOString(),
			revision: current.revision + 1,
			latestReleaseId: current.latestReleaseId,
			lastReport: undefined,
			domjudgePdf: content.domjudgePdf,
			checkerMode: content.checkerMode ?? (content.checkerSource.trim() ? "custom" : "text"),
			oracle: content.oracle,
			generatedFromHash: content.generatedFromHash,
		});
		await projects.database.commitFiles(
			files,
			() => {
				assertAccess();
				projects.save(current);
			},
			["manual", "generated", "pdf"].map((kind) => ({ ownerKind: kind, ownerId: id })),
		);
		return projects.snapshot(id);
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
			throw new ManualProjectError("发布包源文件不完整，无法回退。", 422);
		throw error;
	} finally {
		unlock();
	}
}
