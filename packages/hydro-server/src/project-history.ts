import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFlatName } from "@setdraft/authoring";
import {
	isProjectSnapshot,
	type ManualProjectSnapshot,
	synchronizeGenerators,
	synchronizeProblemType,
	synchronizeSolutions,
} from "@setdraft/contracts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";
import { hashFile } from "./project-files.ts";
import type { WorkspaceFile } from "./workspace-db.ts";

function checkRevision(project: Pick<ManualProjectSnapshot, "revision">, expected: unknown): void {
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
	assertAccess: () => void | Promise<void> = () => {},
): Promise<ManualProjectSnapshot> {
	const unlock = await source.lock(id);
	try {
		const { snapshot, version, entries } = await source.database.transaction(async () => {
			const snapshot = await source.snapshot(id);
			checkRevision(snapshot, expectedRevision);
			if (snapshot.dataIssues?.length) throw new ManualProjectError("请先修复冲突测试文件。", 422);
			const entries = [];
			for (const kind of ["manual", "generated", "pdf"] as const)
				for (const file of await source.database.fileEntries(kind, id)) entries.push({ kind, ...file });
			return { snapshot, version: await source.database.version("project", id), entries };
		});
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
		for (const file of entries) {
			if (file.kind !== "pdf") {
				if (file.size > target.maxFileBytes) throw new ManualProjectError("测试数据超过接收工作区限制。", 413);
				files.push({
					ownerKind: file.kind,
					ownerId: newId,
					name: file.name,
					source: { path: join(source.root, "blobs", file.hash.slice(0, 2), file.hash) },
				});
			}
		}
		if (
			entries.filter((file) => file.kind !== "pdf").reduce((sum, file) => sum + file.size, 0) >
			target.maxProjectBytes
		)
			throw new ManualProjectError("测试数据超过接收工作区限制。", 413);
		const pdf = entries.find((file) => file.kind === "pdf" && file.name === "problem.pdf");
		if (project.domjudgePdf && !pdf) throw new ManualProjectError("题目 PDF 文件缺失，无法复制。", 422);
		if (project.domjudgePdf && pdf)
			files.push({
				ownerKind: "pdf",
				ownerId: newId,
				name: "problem.pdf",
				source: { path: join(source.root, "blobs", pdf.hash.slice(0, 2), pdf.hash) },
			});
		await mkdir(join(target.projectDirectory(newId), "manual"), { recursive: true });
		await target.database.commitFiles(files, async () => {
			await assertAccess();
			await target.assertNotBusy(newId);
			if (version !== (await source.database.version("project", id)))
				throw new ManualProjectError("题目版本已变化，请重试复制。", 409);
			await target.database.put("project", newId, project, -1);
		});
		return await target.snapshot(newId);
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
	assertAccess: () => void | Promise<void> = () => {},
): Promise<ManualProjectSnapshot> {
	const release = await projects.releases.release(releaseId);
	if (release.projectId !== id) throw new ManualProjectError("发布包不存在。", 404);
	const unlock = await projects.lock(id);
	try {
		const current = await projects.load(id);
		checkRevision(current, expectedRevision);
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
					judgingMode: record.judgingMode ?? "default",
					interactionInputMode: record.interactionInputMode ?? "provided",
					interactorSource: record.interactorSource ?? "",
					interactorStandard: record.interactorStandard ?? "cpp17",
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
				item?.origin === "automatic" &&
				candidate.judgingMode === "interactive" &&
				candidate.interactionInputMode === "empty" &&
				item.inputFile === "interactive-empty.in"
			) {
				if ((await readFile(await checked("data/automatic/interactive-empty.in"))).length !== 0)
					throw new ManualProjectError("无测试输入模式的测试输入必须严格为空。", 422);
				continue;
			}
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
			solutions: content.solutions,
			referenceSolutionId: content.referenceSolutionId,
			generators: content.generators,
			generatorSequence: content.generatorSequence,
			statementSections: content.statementSections,
			generatedFromHash: content.generatedFromHash,
		});
		current.problemType = candidate.problemType;
		current.communication = candidate.communication;
		current.protocolSamples = candidate.protocolSamples;
		synchronizeProblemType(current);
		synchronizeSolutions(current);
		synchronizeGenerators(current);
		await projects.database.commitFiles(
			files,
			async () => {
				await assertAccess();
				await projects.save(current);
			},
			["manual", "generated", "pdf"].map((kind) => ({ ownerKind: kind, ownerId: id })),
		);
		return await projects.snapshot(id);
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
			throw new ManualProjectError("发布包源文件不完整，无法回退。", 422);
		throw error;
	} finally {
		unlock();
	}
}
