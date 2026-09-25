import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSafeFlatName, writeStoredArchiveFromFiles } from "@hydro-problem-make/authoring";
import { domjudgeProblemId } from "./domjudge-export.ts";
import { ManualProjectError, type ManualProjectStore, type ManualRelease } from "./manual-projects.ts";

export type ContestFormat = "hydro" | "domjudge";

export interface ContestDraft {
	id: string;
	title: string;
	slug: string;
	releaseIds: string[];
	colors: Record<string, string>;
	colorNames: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface ContestRelease {
	id: string;
	contestId: string;
	title: string;
	slug: string;
	format: ContestFormat;
	problems: Array<{
		label: string;
		releaseId: string;
		projectHash: string;
		title: string;
		color?: string;
		colorName?: string;
	}>;
	createdAt: string;
}

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

async function readJsonFile<T>(path: string, missingMessage: string): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError(missingMessage, 404);
		throw error;
	}
}

export class ContestStore {
	readonly root: string;
	readonly projects: ManualProjectStore;
	private readonly busy = new Set<string>();

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
		const target = join(this.draftDirectory(draft.id), "contest.json");
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`);
		await rename(temporary, target);
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
			title,
			slug,
			releaseIds: [],
			colors: {},
			colorNames: {},
			createdAt: now,
			updatedAt: now,
		};
		await mkdir(this.draftDirectory(id), { recursive: true });
		await this.save(draft);
		return draft;
	}

	async get(id: string): Promise<ContestDraft> {
		const draft = await readJsonFile<ContestDraft>(join(this.draftDirectory(id), "contest.json"), "竞赛不存在。");
		return { ...draft, colorNames: draft.colorNames ?? {} };
	}

	async list(): Promise<ContestDraft[]> {
		const directory = join(this.root, "contests");
		const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const drafts = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
				.map((entry) => this.get(entry.name)),
		);
		return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	private async selectedReleases(releaseIds: string[]): Promise<ManualRelease[]> {
		if (releaseIds.length > 100 || new Set(releaseIds).size !== releaseIds.length) {
			throw new ManualProjectError("竞赛最多 100 题，且发布版本不能重复。", 422);
		}
		const releases = await Promise.all(releaseIds.map((id) => this.projects.release(id)));
		if (
			releases.some(
				(release) =>
					!release.report.success ||
					release.report.mode !== "finalize" ||
					!release.report.checkerUsed ||
					(release.checkerMode !== "text" && release.checkerMode !== "custom") ||
					(release.scoringMode !== "acm" && release.scoringMode !== "oi"),
			)
		) {
			throw new ManualProjectError(
				"竞赛只能使用已选择赛制、通过完整 Checker 验证的新发布版本；旧题请重新验证并发布。",
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
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new ManualProjectError("竞赛资料无效。");
		const input = value as Record<string, unknown>;
		const draft = await this.get(id);
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
		const updated = {
			...draft,
			title,
			slug,
			releaseIds,
			colors: normalizedColors,
			colorNames: normalizedColorNames,
			updatedAt: new Date().toISOString(),
		};
		await this.save(updated);
		return updated;
	}

	async export(id: string, format: ContestFormat): Promise<ContestRelease> {
		if (this.busy.has(id)) throw new ManualProjectError("竞赛正在导出。", 409);
		this.busy.add(id);
		let stage: string | undefined;
		let releaseRoot: string | undefined;
		try {
			const draft = await this.get(id);
			if (draft.releaseIds.length === 0) throw new ManualProjectError("请先加入至少一道题。", 422);
			const releases = await this.selectedReleases(draft.releaseIds);
			if (format === "domjudge" && releases.some((release) => release.scoringMode !== "acm")) {
				throw new ManualProjectError("DOMjudge 竞赛只支持 ACM 题目；包含 OI 题目时请选择 Hydro。", 422);
			}
			const archiveId = randomUUID();
			releaseRoot = this.releaseDirectory(archiveId);
			await mkdir(releaseRoot, { recursive: true });
			stage = await mkdtemp(join(releaseRoot, ".stage-"));
			const files = new Map<string, string>();
			const problems = [];
			const metadata = [];
			for (const [index, release] of releases.entries()) {
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
					const archive = await this.projects.exportDomjudge(release.id);
					files.set(`problems/${label}.zip`, archive.path);
					metadata.push(
						`- id: ${domjudgeProblemId(release.id)}\n  label: ${label}\n  name: ${JSON.stringify(release.title)}\n  color: ${JSON.stringify(colorName)}\n  rgb: '${color}'`,
					);
				} else {
					const archive = await this.projects.releaseFile(release.id, "hydro");
					files.set(`problems/${label}-${release.slug}.zip`, archive.path);
				}
			}
			const contestRelease: ContestRelease = {
				id: archiveId,
				contestId: id,
				title: draft.title,
				slug: draft.slug,
				format,
				problems,
				createdAt: new Date().toISOString(),
			};
			const manifestPath = join(stage, "manifest.json");
			await writeFile(manifestPath, `${JSON.stringify(contestRelease, null, 2)}\n`);
			files.set("manifest.json", manifestPath);
			const instructionsPath = join(stage, "README.txt");
			await writeFile(
				instructionsPath,
				format === "domjudge"
					? "先在 DOMjudge 中创建竞赛，再导入 problems.yaml，然后逐个上传 problems/ 下的题目 ZIP。竞赛赛程由 DOMjudge 管理。\n"
					: "逐个导入 problems/ 下的 Hydro 题目 ZIP，再按 manifest.json 中的顺序加入 Hydro 竞赛。\n",
			);
			files.set("README.txt", instructionsPath);
			if (format === "domjudge") {
				const yamlPath = join(stage, "problems.yaml");
				await writeFile(yamlPath, `${metadata.join("\n")}\n`);
				files.set("problems.yaml", yamlPath);
			}
			await writeStoredArchiveFromFiles(join(releaseRoot, "bundle.zip"), draft.slug, files);
			await writeFile(join(releaseRoot, "release.json"), `${JSON.stringify(contestRelease, null, 2)}\n`);
			releaseRoot = undefined;
			return contestRelease;
		} finally {
			if (stage) await rm(stage, { recursive: true, force: true });
			if (releaseRoot) await rm(releaseRoot, { recursive: true, force: true });
			this.busy.delete(id);
		}
	}

	async release(id: string): Promise<ContestRelease> {
		return readJsonFile(join(this.releaseDirectory(id), "release.json"), "竞赛发布记录不存在。");
	}

	async listReleases(): Promise<ContestRelease[]> {
		const directory = join(this.root, "contest-releases");
		const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const releases = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
				.map((entry) => this.release(entry.name)),
		);
		return releases.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async releaseFile(id: string): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		const path = join(this.releaseDirectory(id), "bundle.zip");
		return { path, size: (await stat(path)).size, name: `${release.slug}.${release.format}.contest.zip` };
	}

	async delete(id: string): Promise<void> {
		if (this.busy.has(id)) throw new ManualProjectError("竞赛正在导出。", 409);
		await this.get(id);
		await rm(this.draftDirectory(id), { recursive: true, force: true });
	}

	async assertProblemReleasesUnreferenced(releaseIds: string[]): Promise<void> {
		const targeted = new Set(releaseIds);
		for (const draft of await this.list()) {
			if (draft.releaseIds.some((id) => targeted.has(id))) {
				throw new ManualProjectError(`题目已被竞赛“${draft.title}”引用，请先从竞赛草稿移出再删除。`, 409);
			}
		}
	}
}
