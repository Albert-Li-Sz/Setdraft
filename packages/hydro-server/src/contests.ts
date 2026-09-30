import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSafeFlatName, writeStoredArchiveFromFiles } from "@setdraft/authoring";
import {
	type ContestDraft,
	type ContestFormat,
	type ContestRelease,
	isContestReadyRelease,
	isProjectSnapshot,
} from "@setdraft/contracts";
import { compileContestPdfs } from "./contest-pdf.ts";
import type { ContestPdfDocument } from "./contest-pdf-document.ts";
import { readContestPdfOptions } from "./contest-pdf-options.ts";
import { domjudgeProblemId } from "./domjudge-export.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { ManualProjectError, type ManualProjectStore, type ManualRelease } from "./manual-projects.ts";
import { hashFile } from "./project-files.ts";
import { releaseName } from "./releases.ts";
import { cleanupSandboxStage } from "./sandbox-runtime.ts";

export type { ContestDraft, ContestFormat, ContestRelease } from "@setdraft/contracts";

const idPattern = /^[a-f0-9-]{36}$/u;
const colorPattern = /^#[0-9a-fA-F]{6}$/u;
const defaultBalloons = [
	{ name: "Red", rgb: "#EF4444" },
	{ name: "Orange", rgb: "#F59E0B" },
	{ name: "Green", rgb: "#22C55E" },
	{ name: "Cyan", rgb: "#06B6D4" },
	{ name: "Indigo", rgb: "#6366F1" },
	{ name: "Purple", rgb: "#A855F7" },
];

function checkId(id: string): void {
	if (!idPattern.test(id)) throw new ManualProjectError("竞赛 ID 无效。", 404);
}

function checkSlug(slug: string): void {
	if (!isSafeFlatName(slug) || slug.length > 80 || slug === "." || slug === "..") {
		throw new ManualProjectError("竞赛标识只能使用字母、数字、点、下划线和连字符。", 422);
	}
}

function labelAt(index: number): string {
	let number = index + 1;
	let label = "";
	while (number > 0) {
		number -= 1;
		label = String.fromCharCode(65 + (number % 26)) + label;
		number = Math.floor(number / 26);
	}
	return label;
}

export class ContestStore {
	readonly root: string;
	readonly projects: ManualProjectStore;
	private readonly busy = new Set<string>();
	private readonly documentVersions = new WeakMap<object, number>();

	constructor(projects: ManualProjectStore) {
		this.projects = projects;
		this.root = resolve(projects.root);
	}

	private draftDirectory(id: string): string {
		checkId(id);
		return join(this.root, "contests", id);
	}

	private releaseDirectory(id: string): string {
		checkId(id);
		return join(this.root, "contest-releases", id);
	}

	private async save(draft: ContestDraft): Promise<void> {
		const knownVersion = this.documentVersions.get(draft);
		const expectedVersion = knownVersion ?? (await this.projects.database.version("contest", draft.id)) ?? -1;
		try {
			await this.projects.database.transaction(async () => {
				if (
					await this.projects.database.sql.one("SELECT 1 FROM tasks WHERE resource=$1 AND state='running'", [
						`contest:${draft.id}`,
					])
				)
					throw new ManualProjectError("竞赛正在导出，请稍后修改。", 409);
				await this.projects.database.put("contest", draft.id, draft, expectedVersion);
			});
		} catch (error) {
			if (String(error).includes("VERSION_CONFLICT")) {
				throw new ManualProjectError("竞赛版本已变化，请刷新后重试。", 409, await this.get(draft.id));
			}
			throw error;
		}
		this.documentVersions.set(draft, expectedVersion + 1);
	}

	async create(value: unknown): Promise<ContestDraft> {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new ManualProjectError("竞赛资料无效。");
		const input = value as Record<string, unknown>;
		const title = typeof input.title === "string" ? input.title.trim() : "";
		const slug = typeof input.slug === "string" ? input.slug.trim() : "";
		if (!title || title.length > 160) throw new ManualProjectError("请输入不超过 160 字的竞赛名称。", 422);
		checkSlug(slug);
		const id = randomUUID();
		const now = new Date().toISOString();
		const draft: ContestDraft = {
			id,
			revision: 0,
			title,
			slug,
			releaseIds: [],
			colors: {},
			colorNames: {},
			pdf: readContestPdfOptions(input.pdf),
			createdAt: now,
			updatedAt: now,
		};
		await mkdir(this.draftDirectory(id), { recursive: true });
		await this.save(draft);
		return draft;
	}

	async get(id: string): Promise<ContestDraft> {
		const document = await this.projects.database.getVersioned<ContestDraft>("contest", id);
		if (!document) throw new ManualProjectError("竞赛不存在。", 404);
		const { value: draft, version } = document;
		const snapshot = {
			...draft,
			revision: draft.revision ?? 0,
			colorNames: draft.colorNames ?? {},
			pdf: readContestPdfOptions(draft.pdf),
		};
		if (version !== undefined) this.documentVersions.set(snapshot, version);
		return snapshot;
	}

	async list(): Promise<ContestDraft[]> {
		const drafts = await Promise.all(
			(await this.projects.database.list<ContestDraft>("contest")).map(async (item) => await this.get(item.id)),
		);
		return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	private async selectedReleases(releaseIds: string[]): Promise<ManualRelease[]> {
		if (releaseIds.length > 100 || new Set(releaseIds).size !== releaseIds.length) {
			throw new ManualProjectError("竞赛最多 100 题，且发布版本不能重复。", 422);
		}
		const releases = await Promise.all(releaseIds.map(async (id) => await this.projects.releases.release(id)));
		if (releases.some((release) => !isContestReadyRelease(release))) {
			throw new ManualProjectError(
				"竞赛只能使用已选择赛制、通过完整判题验证的新发布版本；旧题请重新验证并发布。",
				422,
			);
		}
		if (new Set(releases.map((release) => release.projectId)).size !== releases.length) {
			throw new ManualProjectError("同一道题不能重复加入竞赛。", 422);
		}
		return releases;
	}

	async update(id: string, value: unknown): Promise<ContestDraft> {
		if (this.busy.has(id)) throw new ManualProjectError("竞赛正在导出，请稍后修改。", 409);
		const running = (await this.projects.database.sql.one(
			"SELECT id FROM tasks WHERE resource=$1 AND state='running'",
			[`contest:${id}`],
		)) as { id: string } | undefined;
		if (running) throw new ManualProjectError("竞赛正在导出，请稍后修改。", 409);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new ManualProjectError("竞赛资料无效。");
		const input = value as Record<string, unknown>;
		const draft = await this.get(id);
		if (input.expectedRevision !== undefined && input.expectedRevision !== draft.revision) {
			throw new ManualProjectError("竞赛版本已变化，请刷新后重试。", 409, draft);
		}
		const title = typeof input.title === "string" ? input.title.trim() : "";
		const slug = typeof input.slug === "string" ? input.slug.trim() : "";
		if (!title || title.length > 160) throw new ManualProjectError("请输入不超过 160 字的竞赛名称。", 422);
		checkSlug(slug);
		if (!Array.isArray(input.releaseIds) || input.releaseIds.some((item) => typeof item !== "string")) {
			throw new ManualProjectError("题目列表无效。", 422);
		}
		const releaseIds = input.releaseIds as string[];
		const releases = await this.selectedReleases(releaseIds);
		if (typeof input.colors !== "object" || input.colors === null || Array.isArray(input.colors)) {
			throw new ManualProjectError("气球颜色配置无效。", 422);
		}
		const colors = input.colors as Record<string, unknown>;
		const normalizedColors: Record<string, string> = {};
		for (const [releaseId, color] of Object.entries(colors)) {
			if (!releaseIds.includes(releaseId) || typeof color !== "string" || !colorPattern.test(color)) {
				throw new ManualProjectError("气球颜色须为 #RRGGBB，且只能对应已选题目。", 422);
			}
			normalizedColors[releaseId] = color.toUpperCase();
		}
		const namesInput =
			input.colorNames === undefined
				? Object.fromEntries(
						Object.entries(draft.colorNames).filter(([releaseId]) => releaseIds.includes(releaseId)),
					)
				: input.colorNames;
		if (typeof namesInput !== "object" || namesInput === null || Array.isArray(namesInput)) {
			throw new ManualProjectError("气球颜色名称配置无效。", 422);
		}
		const normalizedColorNames: Record<string, string> = {};
		for (const [releaseId, value] of Object.entries(namesInput)) {
			if (
				!releaseIds.includes(releaseId) ||
				typeof value !== "string" ||
				!value.trim() ||
				value.trim().length > 40 ||
				/[\u0000-\u001f\u007f]/u.test(value)
			) {
				throw new ManualProjectError("气球颜色名称须为 1–40 字的单行文本，且只能对应已选题目。", 422);
			}
			normalizedColorNames[releaseId] = value.trim();
		}
		for (const release of releases) {
			if (release.scoringMode !== "acm" && (normalizedColors[release.id] || normalizedColorNames[release.id])) {
				throw new ManualProjectError("OI 题目不能设置 DOMjudge 气球颜色。", 422);
			}
		}
		const updated = Object.assign(draft, {
			title,
			slug,
			releaseIds,
			colors: normalizedColors,
			colorNames: normalizedColorNames,
			pdf: input.pdf === undefined ? draft.pdf : readContestPdfOptions(input.pdf),
			revision: draft.revision + 1,
			updatedAt: new Date().toISOString(),
		});
		await this.save(updated);
		return updated;
	}

	private async pdfDocument(draft: ContestDraft, releases: ManualRelease[]): Promise<ContestPdfDocument> {
		const options = readContestPdfOptions(draft.pdf);
		const problems: ContestPdfDocument["problems"] = [];
		let totalBytes = Buffer.byteLength(JSON.stringify({ title: draft.title, options, problems }));
		for (const [index, release] of releases.entries()) {
			const sourceRoot = join(this.projects.releaseDirectory(release.id), "source");
			const projectPath = join(sourceRoot, "project.json");
			const manifestPath = join(sourceRoot, "manifest.json");
			if ((await stat(projectPath)).size > 32 * 1024 * 1024 || (await stat(manifestPath)).size > 2 * 1024 * 1024)
				throw new ManualProjectError("发布源快照超过 PDF 读取限制。", 422);
			const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
			if (
				!manifest ||
				typeof manifest !== "object" ||
				!("projectId" in manifest) ||
				manifest.projectId !== release.projectId ||
				!("projectHash" in manifest) ||
				manifest.projectHash !== release.projectHash ||
				!("files" in manifest) ||
				!manifest.files ||
				typeof manifest.files !== "object" ||
				!("project.json" in manifest.files) ||
				manifest.files["project.json"] !== (await hashFile(projectPath))
			)
				throw new ManualProjectError("发布包题面快照校验失败。", 422);
			const raw: unknown = JSON.parse(await readFile(projectPath, "utf8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw))
				throw new ManualProjectError("发布包题面快照无效。", 422);
			const project = { ...raw, cases: [], orphanOutputs: [] };
			if (!isProjectSnapshot(project) || project.id !== release.projectId || project.revision !== release.revision)
				throw new ManualProjectError("发布包题面快照无效。", 422);
			const problem = {
				label: labelAt(index),
				title: release.title,
				statement: project.statementSections ? "" : project.statement,
				statementSections: project.statementSections,
				judgingMode: project.judgingMode,
				samples: project.samples,
				attachments: project.attachments,
				timeLimit: project.timeLimit,
				memoryLimit: project.memoryLimit,
			};
			totalBytes += Buffer.byteLength(JSON.stringify(problem)) + 1;
			if (totalBytes > 20 * 1024 * 1024) throw new ManualProjectError("PDF 题面与附件合计不能超过 20 MiB。", 422);
			problems.push(problem);
		}
		return { title: draft.title, options, problems };
	}

	async previewPdf(id: string, expectedRevision: unknown, signal?: AbortSignal): Promise<Buffer> {
		const draft = await this.get(id);
		if (draft.revision !== expectedRevision) throw new ManualProjectError("竞赛版本已变化，请保存配置后重试。", 409);
		if (!draft.releaseIds.length) throw new ManualProjectError("请先加入至少一道题。", 422);
		const document = await this.pdfDocument(draft, await this.selectedReleases(draft.releaseIds));
		const result = await compileContestPdfs(this.draftDirectory(id), document, signal, true);
		try {
			return await readFile(result.booklet);
		} finally {
			await result.cleanup();
		}
	}

	async export(id: string, format: ContestFormat, context?: ExecutionContext, name?: string): Promise<ContestRelease> {
		if (this.busy.has(id)) throw new ManualProjectError("竞赛正在导出。", 409);
		this.busy.add(id);
		let stage: string | undefined;
		let releaseRoot: string | undefined;
		let archiveId: string | undefined;
		let pdfs: Awaited<ReturnType<typeof compileContestPdfs>> | undefined;
		try {
			const draft = await this.get(id);
			if (draft.releaseIds.length === 0) throw new ManualProjectError("请先加入至少一道题。", 422);
			const releases = await this.selectedReleases(draft.releaseIds);
			if (format === "domjudge" && releases.some((release) => release.scoringMode !== "acm")) {
				throw new ManualProjectError("DOMjudge 竞赛只支持 ACM 题目；包含 OI 题目时请选择 Hydro。", 422);
			}
			archiveId = randomUUID();
			releaseRoot = this.releaseDirectory(archiveId);
			await mkdir(releaseRoot, { recursive: true });
			stage = await mkdtemp(join(releaseRoot, ".stage-"));
			const files = new Map<string, string>();
			if (draft.pdf?.enabled) {
				context?.emit("pdf", "正在生成竞赛题册与单题 PDF…");
				pdfs = await compileContestPdfs(stage, await this.pdfDocument(draft, releases), context?.signal);
				files.set("booklet.pdf", pdfs.booklet);
				for (const [label, path] of pdfs.problems) files.set(`statements/${label}.pdf`, path);
			}
			const problems = [];
			const metadata = [];
			for (const [index, release] of releases.entries()) {
				context?.signal.throwIfAborted();
				const label = labelAt(index);
				const balloon = defaultBalloons[index % defaultBalloons.length];
				const color = format === "domjudge" ? (draft.colors[release.id] ?? balloon.rgb) : undefined;
				const colorName = format === "domjudge" ? (draft.colorNames[release.id] ?? balloon.name) : undefined;
				problems.push({
					label,
					releaseId: release.id,
					projectHash: release.projectHash,
					title: release.title,
					...(color ? { color } : {}),
					...(colorName ? { colorName } : {}),
				});
				if (format === "domjudge") {
					const pdfPath = pdfs?.problems.get(label);
					const archive = await this.projects.releases.exportDomjudge(
						release.id,
						context,
						pdfPath ? { pdfPath, archivePath: join(stage, `${label}.zip`) } : undefined,
					);
					files.set(`problems/${label}.zip`, archive.path);
					metadata.push(
						`- id: ${domjudgeProblemId(release.id)}\n  label: ${label}\n  name: ${JSON.stringify(release.title)}\n  color: ${JSON.stringify(colorName)}\n  rgb: '${color}'`,
					);
				} else {
					const archive = await this.projects.releases.releaseFile(release.id, "hydro");
					files.set(`problems/${label}-${release.slug}.zip`, archive.path);
				}
			}
			const contestRelease: ContestRelease = {
				id: archiveId,
				contestId: id,
				name: name === undefined ? draft.title : releaseName(name),
				title: draft.title,
				slug: draft.slug,
				format,
				...(draft.pdf?.enabled ? { pdf: draft.pdf } : {}),
				problems,
				createdAt: new Date().toISOString(),
			};
			const manifestPath = join(stage, "manifest.json");
			await writeFile(manifestPath, `${JSON.stringify(contestRelease, null, 2)}\n`);
			files.set("manifest.json", manifestPath);
			const instructionsPath = join(stage, "README.txt");
			await writeFile(
				instructionsPath,
				(format === "domjudge"
					? "先在 DOMjudge 中创建竞赛，再导入 problems.yaml，然后逐个上传 problems/ 下的题目 ZIP。竞赛赛程由 DOMjudge 管理。\n"
					: "逐个导入 problems/ 下的 Hydro 题目 ZIP，再按 manifest.json 中的顺序加入 Hydro 竞赛。\n") +
					(pdfs
						? "booklet.pdf 为完整题册，statements/ 为单题 PDF；DOMjudge 题目 ZIP 已附带对应的单题题面。\n"
						: ""),
			);
			files.set("README.txt", instructionsPath);
			if (format === "domjudge") {
				const yamlPath = join(stage, "problems.yaml");
				await writeFile(yamlPath, `${metadata.join("\n")}\n`);
				files.set("problems.yaml", yamlPath);
			}
			await writeStoredArchiveFromFiles(join(releaseRoot, "bundle.zip"), draft.slug, files);
			context?.signal.throwIfAborted();
			await this.projects.database.commitFiles(
				[
					{
						ownerKind: "contest-bundle",
						ownerId: archiveId,
						name: "bundle.zip",
						source: { path: join(releaseRoot, "bundle.zip") },
					},
					...(pdfs
						? [
								{
									ownerKind: "contest-bundle",
									ownerId: archiveId,
									name: "booklet.pdf",
									source: { path: pdfs.booklet },
								},
							]
						: []),
				],
				async () => {
					context?.signal.throwIfAborted();
					if ((await this.projects.database.version("contest", id)) !== this.documentVersions.get(draft))
						throw new ManualProjectError("竞赛版本已变化，请重试导出。", 409);
					await this.projects.database.put("contest-release", contestRelease.id, contestRelease);
				},
			);
			releaseRoot = undefined;
			return contestRelease;
		} finally {
			this.busy.delete(id);
			try {
				await pdfs?.cleanup();
			} finally {
				try {
					if (stage) await cleanupSandboxStage(stage);
				} finally {
					if (releaseRoot) {
						try {
							if (archiveId) {
								await this.projects.database.delete("contest-release", archiveId);
								await this.projects.database.removeOwnerFiles("contest-bundle", archiveId);
							}
						} finally {
							await cleanupSandboxStage(releaseRoot);
						}
					}
				}
			}
		}
	}

	async release(id: string): Promise<ContestRelease> {
		const stored = await this.projects.database.get<ContestRelease>("contest-release", id);
		if (!stored) throw new ManualProjectError("竞赛发布记录不存在。", 404);
		return stored;
	}

	async listReleases(): Promise<ContestRelease[]> {
		const releases = await this.projects.database.list<ContestRelease>("contest-release");
		return releases.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async releaseFile(
		id: string,
		kind: "bundle" | "pdf" = "bundle",
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		if (kind === "pdf" && !release.pdf?.enabled) throw new ManualProjectError("该竞赛包未包含 PDF。", 404);
		const name = kind === "pdf" ? "booklet.pdf" : "bundle.zip";
		const path =
			(await this.projects.database.filePath("contest-bundle", id, name)) ?? join(this.releaseDirectory(id), name);
		return {
			path,
			size: (await stat(path)).size,
			name: kind === "pdf" ? `${release.slug}.pdf` : `${release.slug}.${release.format}.contest.zip`,
		};
	}

	async delete(id: string): Promise<void> {
		if (this.busy.has(id)) throw new ManualProjectError("竞赛正在导出。", 409);
		const running = await this.projects.database.sql.one(
			"SELECT id FROM tasks WHERE resource=$1 AND state='running'",
			[`contest:${id}`],
		);
		if (running) throw new ManualProjectError("竞赛正在导出。", 409);
		await this.get(id);
		await this.projects.database.delete("contest", id);
		await rm(this.draftDirectory(id), { recursive: true, force: true });
	}

	async assertProblemReleasesUnreferenced(releaseIds: string[]): Promise<void> {
		const targeted = new Set(releaseIds);
		for (const draft of await this.list()) {
			if (draft.releaseIds.some((id) => targeted.has(id))) {
				throw new ManualProjectError(`题目已被竞赛“${draft.title}”引用，请先从竞赛移出再删除。`, 409);
			}
		}
	}
}
