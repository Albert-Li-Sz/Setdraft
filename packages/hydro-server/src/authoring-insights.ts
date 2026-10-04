import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { extractAttachmentReferences } from "@setdraft/authoring";
import { formatHydroStatement } from "@setdraft/authoring/statement";
import {
	type AuthoringIssue,
	type AuthoringTarget,
	aggregateScore,
	allocateCaseScores,
	type BoundaryCoverage,
	type DataQualityReport,
	evaluateSolution,
	isCompleteCommunicationResult,
	type ManualCaseSummary,
	type ManualProjectSnapshot,
	type MatrixCell,
	type PublicationReadiness,
	projectSolutions,
	readProjectSnapshot,
	resolveProblemType,
	type SolutionResult,
	type VerificationRun,
	verificationContractVersion,
} from "@setdraft/contracts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { ManualProjectError } from "./project-error.ts";

const caseKey = (item: ManualCaseSummary) => `${item.origin}:${item.id}`;
export function activeQualityCases(project: ManualProjectSnapshot): ManualCaseSummary[] {
	return project.judgingMode === "interactive" && project.interactionInputMode === "empty"
		? [{ id: "interactive-empty", origin: "manual", inputFile: "interactive-empty.in", inputBytes: 0, subtaskId: 1 }]
		: project.cases;
}
const subtasksFor = (project: ManualProjectSnapshot) =>
	project.judgingMode === "interactive" && project.interactionInputMode === "empty"
		? [{ id: 1, type: "min" as const, score: 100 }]
		: project.subtasks;
async function inputPrefix(path: string, count: number): Promise<string[]> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const tokens: string[] = [];
	let token = "";
	try {
		for await (const chunk of stream) {
			if (typeof chunk !== "string") throw new Error("输入文件编码错误。");
			for (const match of chunk.matchAll(/\s+|\S+/gu)) {
				if (/^\s/u.test(match[0])) {
					if (token) {
						tokens.push(token);
						token = "";
						if (tokens.length === count) return tokens;
					}
				} else if (token.length <= 100) {
					// Keep overlong values invalid without retaining an unbounded token.
					token += match[0].slice(0, 101 - token.length);
				}
			}
		}
		if (token) tokens.push(token);
		return tokens;
	} finally {
		stream.destroy();
	}
}
interface Evidence {
	runId: string;
	cells: MatrixCell[];
	result: SolutionResult;
}

/** No partial, cancelled, stale or infrastructure-failed result can prove data coverage. */
async function evidenceFor(
	projects: ManualProjectStore,
	project: ManualProjectSnapshot,
): Promise<Map<string, Evidence>> {
	const evidence = new Map<string, Evidence>();
	const solutions = projectSolutions(project);
	const cases = activeQualityCases(project);
	const rows = await projects.database.sql.all<{ body: VerificationRun }>(
		`SELECT body FROM documents WHERE kind='verification-run' AND body->>'projectId'=$1
		AND body->>'revision'=$2 AND body->>'state'='complete' AND body->>'verificationContractVersion'=$3
		AND body->'matrix'->>'full'='true' AND body->'options'->>'kind' IN ('matrix','pressure')
		ORDER BY body->>'createdAt' DESC,id DESC`,
		[project.id, String(project.revision), String(verificationContractVersion)],
	);
	const currentFiles = new Map<string, string>();
	for (const origin of ["manual", "generated"] as const)
		for (const file of await projects.database.fileEntries(origin, project.id))
			currentFiles.set(`${origin}/${file.name}`, file.hash);
	for (const { body } of rows) {
		if (evidence.size === solutions.length) break;
		if (
			!body.solutions.some((item) => solutions.some((solution) => solution.id === item.id && !evidence.has(item.id)))
		)
			continue;
		const path = await projects.database.filePath("verification-file", body.id, "project.json");
		if (!path) continue;
		let saved: ManualProjectSnapshot;
		try {
			saved = readProjectSnapshot(JSON.parse(await readFile(path, "utf8")));
		} catch {
			continue;
		}
		const executionConfig = (value: ManualProjectSnapshot) => [
			resolveProblemType(value),
			value.communication,
			value.interactionInputMode,
			value.interactorSource,
			value.interactorStandard,
			value.timeLimit,
			value.memoryLimit,
			value.checkerSource,
			value.checkerStandard,
			value.validatorSource,
			value.validatorStandard,
			subtasksFor(value),
			value.referenceSolutionId,
			projectSolutions(value),
		];
		if (saved.revision !== project.revision || !isDeepStrictEqual(executionConfig(saved), executionConfig(project)))
			continue;
		const run = await projects.runs.get(project.id, body.id);
		const matrix = run.matrix;
		if (
			!matrix?.full ||
			!run.fingerprint ||
			matrix.cases.length !== cases.length ||
			new Set(matrix.cases.map(caseKey)).size !== cases.length ||
			!cases.every((item) =>
				matrix.cases.some((entry) => caseKey(entry) === caseKey(item) && entry.subtaskId === item.subtaskId),
			)
		)
			continue;
		const files = new Map(
			(await projects.database.fileEntries("verification-file", run.id)).map((file) => [file.name, file.hash]),
		);
		if (
			!(project.judgingMode === "interactive" && project.interactionInputMode === "empty") &&
			matrix.cases.some(
				(item, index) =>
					files.get(`cases/${index}.in`) !== currentFiles.get(`${item.origin}/${item.inputFile}`) ||
					(project.judgingMode !== "interactive" &&
						item.outputFile &&
						files.get(`cases/${index}.out`) !== currentFiles.get(`${item.origin}/${item.outputFile}`)),
			)
		)
			continue;
		for (const solution of solutions) {
			if (evidence.has(solution.id) || !run.solutions.some((item) => isDeepStrictEqual(item, solution))) continue;
			const cells = matrix.cells.filter((cell) => cell.solutionId === solution.id);
			if (
				new Set(cells.map((cell) => cell.caseId)).size !== cells.length ||
				cells.some((cell) => !cases.some((item) => caseKey(item) === cell.caseId))
			)
				continue;
			const result = evaluateSolution(
				solution,
				cells,
				cases.length,
				aggregateScore(subtasksFor(project), cases, cells),
				true,
			);
			if (
				resolveProblemType(project) === "communication" &&
				cells.some((cell) => !isCompleteCommunicationResult(cell))
			)
				result.complete = false;
			evidence.set(solution.id, { runId: run.id, cells, result });
		}
	}
	return evidence;
}

export async function inspectAuthoring(
	projects: ManualProjectStore,
	projectId: string,
): Promise<{ quality: DataQualityReport; readiness: PublicationReadiness }> {
	// File references and revision are captured together; reject a result if the draft changes during inspection.
	const project = await projects.database.transaction(() => projects.snapshot(projectId));
	const cases = activeQualityCases(project);
	const empty = project.judgingMode === "interactive" && project.interactionInputMode === "empty";
	const subtasks = subtasksFor(project);
	const issues: AuthoringIssue[] = [];
	const add = (
		code: string,
		message: AuthoringIssue["message"],
		severity: AuthoringIssue["severity"] = "warning",
		caseIds?: string[],
	) =>
		issues.push({
			code,
			message,
			severity,
			caseIds,
			target: { tab: "data", caseId: caseIds?.[0], section: "quality" },
		});
	const hashes = new Map<string, string[]>();
	const boundaries: BoundaryCoverage[] = (project.boundaryConditions ?? []).map((item) => ({
		id: item.id,
		name: item.name,
		kind: item.rule.kind,
		caseIds: [],
		missingCaseIds:
			item.rule.kind === "cases"
				? item.rule.caseIds.filter((id) => !cases.some((test) => caseKey(test) === id))
				: [],
	}));
	const inputHashes = new Map<string, string>();
	for (const origin of ["manual", "generated"] as const)
		for (const file of await projects.database.fileEntries(origin, project.id))
			inputHashes.set(`${origin}/${file.name}`, file.hash);
	for (const item of cases) {
		const id = caseKey(item);
		const hash = inputHashes.get(`${item.origin}/${item.inputFile}`);
		if (!empty && hash) hashes.set(hash, [...(hashes.get(hash) ?? []), id]);
		if (!empty && item.inputBytes === 0)
			add("EMPTY_INPUT", { key: "测试点 {0} 的输入为空。", values: [id] }, "warning", [id]);
		if (!empty && item.outputBytes === 0)
			add("EMPTY_OUTPUT", { key: "测试点 {0} 的答案为空。", values: [id] }, "warning", [id]);
		if (!subtasks.some((subtask) => subtask.id === item.subtaskId))
			add("UNASSIGNED_CASE", { key: "测试点 {0} 属于不存在的子任务 {1}。", values: [id, item.subtaskId] }, "error", [
				id,
			]);
		let tokens: string[] | undefined;
		const rules = project.boundaryConditions ?? [];
		if (!empty && rules.some((entry) => entry.rule.kind === "integer")) {
			const maximum = Math.max(...rules.map((entry) => (entry.rule.kind === "integer" ? entry.rule.token : 0)));
			tokens = await inputPrefix(await projects.dataFile(project.id, item.origin, item.inputFile), maximum);
		}
		for (const [index, entry] of rules.entries()) {
			if (entry.rule.kind === "cases") {
				if (entry.rule.caseIds.includes(id)) boundaries[index].caseIds.push(id);
			} else {
				const token = tokens?.[entry.rule.token - 1];
				if (
					token &&
					/^-?\d{1,100}$/u.test(token) &&
					(entry.rule.min === undefined || BigInt(token) >= BigInt(entry.rule.min)) &&
					(entry.rule.max === undefined || BigInt(token) <= BigInt(entry.rule.max))
				)
					boundaries[index].caseIds.push(id);
			}
		}
	}
	const duplicates = [...hashes.values()].filter((ids) => ids.length > 1);
	for (const ids of duplicates)
		add("DUPLICATE_INPUT", { key: "输入完全重复：{0}。", values: [ids.join("、")] }, "warning", ids);
	if (!cases.length) add("NO_CASES", "尚未添加测试数据。", "error");
	if (!empty) {
		for (const orphan of project.orphanOutputs)
			add(
				"ORPHAN_OUTPUT",
				{ key: "答案 {0} 没有对应输入。", values: [orphan] },
				project.judgingMode === "interactive" ? "warning" : "error",
			);
		for (const issue of project.dataIssues ?? [])
			add(
				"ANSWER_CONFLICT",
				{ key: "同一测试点存在多个答案文件：{0}。", values: [issue.files.join("、")] },
				"error",
			);
		const names = new Set<string>();
		for (const item of cases) {
			if (names.has(item.id))
				add("DUPLICATE_CASE_NAME", { key: "手动与生成数据重名：{0}。", values: [item.id] }, "error", [
					caseKey(item),
				]);
			names.add(item.id);
		}
		for (const id of Object.keys(project.caseSubtasks))
			if (!cases.some((item) => caseKey(item) === id))
				add("STALE_ASSIGNMENT", { key: "子任务分配指向已删除的测试点 {0}。", values: [id] });
		if (
			cases.some((item) => item.origin === "generated") &&
			project.generatedFromHash !==
				(await projects.pipeline.generatedHash(
					projectId,
					project,
					cases.filter((item) => item.origin === "manual"),
				))
		)
			add("STALE_GENERATED", "生成器、脚本、主标程或手动数据已改变，请重新生成数据。", "error");
	}
	if (subtasks.reduce((sum, item) => sum + item.score, 0) !== 100)
		add("TOTAL_SCORE", "子任务配分合计必须为 100。", "error");
	if (new Set(subtasks.map((item) => item.id)).size !== subtasks.length)
		add("DUPLICATE_SUBTASK", "子任务编号重复。", "error");
	if (
		!empty &&
		project.scoringMode === "acm" &&
		(subtasks.length !== 1 || subtasks[0].id !== 1 || subtasks[0].type !== "min" || subtasks[0].score !== 100)
	)
		add("ACM_SUBTASK", "ACM 题须使用子任务 1、min 聚合和 100 分。", "error");
	const weights = allocateCaseScores(subtasks, cases);
	const distribution = subtasks.map((item) => {
		const members = cases.filter((test) => test.subtaskId === item.id);
		const zeroPointCases = members.filter((test) => weights.get(caseKey(test)) === 0).map(caseKey);
		if (!Number.isSafeInteger(item.score) || item.score <= 0 || item.score > 100)
			add("SUBTASK_SCORE", { key: "子任务 {0} 配分须为 1–100 的整数。", values: [item.id] }, "error");
		if (!members.length) add("EMPTY_SUBTASK", { key: "子任务 {0} 未分配测试点。", values: [item.id] }, "error");
		if (zeroPointCases.length)
			add(
				"ZERO_POINT_CASES",
				{ key: "子任务 {0} 有 {1} 个测试点配分为零。", values: [item.id, zeroPointCases.length] },
				"warning",
				zeroPointCases,
			);
		return { id: item.id, score: item.score, caseCount: members.length, zeroPointCases };
	});
	for (const boundary of boundaries) {
		if (!boundary.caseIds.length)
			add("UNCOVERED_BOUNDARY", { key: "边界条件“{0}”尚无覆盖测试点。", values: [boundary.name] });
		if (boundary.missingCaseIds.length)
			add("MISSING_BOUNDARY_CASE", {
				key: "边界条件“{0}”关联的测试点已不存在：{1}。",
				values: [boundary.name, boundary.missingCaseIds.join("、")],
			});
	}
	const evidence = await evidenceFor(projects, project);
	const faults = projectSolutions(project)
		.filter((solution) => solution.expectation.kind !== "AC")
		.map((solution) => {
			const item = evidence.get(solution.id);
			const caseIds = item?.result.complete
				? item.cells.filter((cell) => cell.verdict !== "AC" || cell.score !== 100).map((cell) => cell.caseId)
				: [];
			const state = !item
				? ("pending" as const)
				: !item.result.complete
					? ("incomplete" as const)
					: caseIds.length
						? ("detected" as const)
						: ("all-ac" as const);
			return {
				solutionId: solution.id,
				name: solution.name,
				required: solution.required,
				state,
				runId: item?.runId,
				matches: item?.result.complete ? item.result.matches : undefined,
				caseIds,
			};
		});
	const discriminationComplete =
		faults.length > 0 && faults.every((item) => item.state === "detected" || item.state === "all-ac");
	const quality: DataQualityReport = {
		projectId,
		revision: project.revision,
		createdAt: new Date().toISOString(),
		caseCount: cases.length,
		intentionalEmpty: empty,
		issues,
		duplicates,
		subtasks: distribution,
		faults,
		undistinguishedCaseIds: discriminationComplete
			? cases.filter((test) => !faults.some((fault) => fault.caseIds.includes(caseKey(test)))).map(caseKey)
			: [],
		discriminationComplete,
		boundaries,
	};
	const preflight = await projects.pipeline.publicationIssues(project);
	const targetFor = (path: string): AuthoringTarget =>
		path.startsWith("statement")
			? { tab: "statement" }
			: path.startsWith("reference")
				? { tab: "programs", solutionId: project.referenceSolutionId ?? "reference" }
				: path.startsWith("checker") || path.startsWith("interactor")
					? {
							tab: "programs",
							section:
								resolveProblemType(project) === "communication"
									? "communication"
									: path.startsWith("checker")
										? "checker"
										: "interactor",
						}
					: path.startsWith("subtasks")
						? { tab: "data" }
						: { tab: "statement", field: path.split("[")[0] };
	const verified =
		project.lastReport?.verificationContractVersion === verificationContractVersion &&
		project.lastReport.mode === "finalize" &&
		project.lastReport.success &&
		project.lastReport.revision === project.revision;
	const checks: PublicationReadiness["checks"] = [
		{
			id: "statement",
			label: "题面",
			state: preflight.some(
				(item) =>
					["statement", "title", "slug"].some((path) => item.path.startsWith(path)) && item.severity === "error",
			)
				? "error"
				: "ready",
			message: "题面、标题与题目代号检查。",
			target: { tab: "statement" },
		},
		{
			id: "samples",
			label: "样例",
			state:
				project.judgingMode === "interactive"
					? project.protocolSamples?.some((sample) => sample.rounds.some((round) => round.messages.length)) ||
						project.samples.length
						? "ready"
						: "warning"
					: project.samples.length
						? "ready"
						: "warning",
			message: "公开样例用于说明协议；普通样例在完整验证时运行。",
			target: { tab: "statement", section: "samples" },
		},
		{
			id: "data",
			label: "数据",
			state: issues.some((item) => item.severity === "error") ? "error" : issues.length ? "warning" : "ready",
			message: { key: "{0} 个有效测试点；数据质量提示不新增发布门槛。", values: [cases.length] },
			target: { tab: "data", section: "quality" },
		},
	];
	for (const issue of preflight)
		checks.push({
			id: `preflight:${checks.length}`,
			label: issue.code,
			state: issue.severity === "error" ? "error" : "warning",
			message: issue.message,
			target: targetFor(issue.path),
		});
	for (const solution of projectSolutions(project)) {
		const item = evidence.get(solution.id);
		const primary = solution.id === (project.referenceSolutionId ?? "reference");
		checks.push({
			id: `solution:${solution.id}`,
			label: {
				key: primary ? "主标程 · {0}" : solution.required ? "必检程序 · {0}" : "观察程序 · {0}",
				values: [solution.name],
			},
			state: !solution.code.trim()
				? solution.required
					? "error"
					: "warning"
				: !item?.result.complete
					? solution.required
						? "pending"
						: "warning"
					: item.result.matches
						? "ready"
						: solution.required
							? "error"
							: "warning",
			message: !solution.code.trim()
				? "尚未填写源码。"
				: !item
					? "缺少当前版本的完整验证；发布时会补跑必检程序。"
					: !item.result.complete
						? "运行不完整，编译失败或系统错误不能证明预期满足。"
						: {
								key: item.result.matches
									? "完整运行：总分 {0}，符合预期。"
									: "完整运行：总分 {0}，不符合预期。",
								values: [item.result.score],
							},
			target: { tab: "programs", solutionId: solution.id },
		});
	}
	checks.push({
		id: "full-verification",
		label: "完整发布验证",
		state: verified ? "ready" : "pending",
		message: verified ? "当前版本已通过完整发布验证。" : "请运行验证并打包；矩阵与质量报告不能替代完整发布验证。",
		target: { tab: "validation" },
	});
	const legacy =
		project.scoringMode === "acm" &&
		resolveProblemType(project) === "standard" &&
		!extractAttachmentReferences(formatHydroStatement(project)).length;
	const readiness: PublicationReadiness = {
		projectId,
		revision: project.revision,
		verified,
		checks,
		platforms: [
			{ id: "hydro", supported: true, reason: "支持四类题型与 ACM／OI；实际平台导入状态以验收记录为准。" },
			{
				id: "domjudge",
				supported: project.scoringMode === "acm",
				reason:
					project.scoringMode === "acm"
						? "支持 ACM；实际导入与评测需在目标平台验证。"
						: "DOMjudge 导出仅支持 ACM。",
			},
			...(["fps", "qduoj"] as const).map((id) => ({
				id,
				supported: legacy,
				reason: legacy
					? "支持标准 ACM 题的导出；实际导入需在目标平台验证。"
					: "仅支持标准 ACM 题，且题面不能引用附件。",
			})),
		],
	};
	if ((await projects.load(projectId)).revision !== project.revision)
		throw new ManualProjectError("题目在检查过程中已改变，请刷新报告。", 409, await projects.snapshot(projectId));
	return { quality, readiness };
}
