import type { HydroProblemSpec, ValidationIssue, ValidationReport } from "./types.ts";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_LANGUAGE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const HYDRO_PID = /^(?![0-9]+$)[A-Za-z0-9]+$/;
const TIME_LIMIT = /^(?:[1-9][0-9]*|0\.[0-9]+|[1-9][0-9]*\.[0-9]+)(?:ms|s)$/;
const MEMORY_LIMIT = /^(?:[1-9][0-9]*|0\.[0-9]+|[1-9][0-9]*\.[0-9]+)(?:k|m|g|kb|mb|gb)$/i;

export function isSafeFlatName(name: string): boolean {
	return SAFE_NAME.test(name) && name !== "." && name !== "..";
}

export function extractAttachmentReferences(markdown: string): string[] {
	const references = new Set<string>();
	for (const match of markdown.matchAll(/file:\/\/([^\s)"'?#]+)/g)) {
		references.add(match[1]);
	}
	return [...references];
}

function addIssue(
	issues: ValidationIssue[],
	code: string,
	path: string,
	message: string,
	severity: "error" | "warning" = "error",
): void {
	issues.push({ severity, code, path, message });
}

function validateLimit(
	issues: ValidationIssue[],
	value: string,
	path: string,
	pattern: RegExp,
	description: string,
): void {
	if (!pattern.test(value)) addIssue(issues, "INVALID_LIMIT", path, description);
}

function validateDependencyGraph(spec: HydroProblemSpec, issues: ValidationIssue[]): void {
	const dependencies = new Map(spec.subtasks.map((subtask) => [subtask.id, [...(subtask.dependsOn ?? [])]]));
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const cycleNodes = new Set<number>();

	const visit = (id: number): void => {
		if (visiting.has(id)) {
			cycleNodes.add(id);
			return;
		}
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of dependencies.get(id) ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};

	for (const id of dependencies.keys()) visit(id);
	if (cycleNodes.size > 0) {
		addIssue(
			issues,
			"CYCLIC_SUBTASK_DEPENDENCY",
			"subtasks",
			`Subtask dependencies contain a cycle involving: ${[...cycleNodes].sort((a, b) => a - b).join(", ")}`,
		);
	}
}

export function validateHydroProblemSpec(spec: HydroProblemSpec): ValidationReport {
	const issues: ValidationIssue[] = [];
	const problemType = spec.type ?? "default";
	if (!["default", "interactive", "submit_answer"].includes(problemType))
		addIssue(issues, "INVALID_PROBLEM_TYPE", "type", "Use default, interactive, or submit_answer.");
	if (problemType === "interactive") {
		if (!spec.interactor?.trim() || !spec.interactor.includes("registerInteraction("))
			addIssue(issues, "MISSING_INTERACTOR", "interactor", "Provide a C++ testlib interactor.");
	} else if (spec.interactor !== undefined)
		addIssue(issues, "UNEXPECTED_INTERACTOR", "interactor", "Only interactive problems use an interactor.");
	if (
		spec.multiPass !== undefined &&
		(!Number.isInteger(spec.multiPass) || spec.multiPass < 2 || spec.multiPass > 20 || problemType !== "interactive")
	)
		addIssue(
			issues,
			"INVALID_MULTI_PASS",
			"multiPass",
			"This local pipeline verifies 2–20 passes for interactive problems.",
		);
	if (problemType === "interactive" && spec.checker)
		addIssue(issues, "UNEXPECTED_CHECKER", "checker", "Interactive problems are scored by the interactor.");
	if (problemType === "submit_answer" && !["single", "multi"].includes(spec.answerMode ?? "single"))
		addIssue(issues, "INVALID_ANSWER_MODE", "answerMode", "Use single or multi answer mode.");
	if (problemType !== "submit_answer" && spec.answerMode !== undefined)
		addIssue(issues, "UNEXPECTED_ANSWER_MODE", "answerMode", "Answer mode is only valid for submit_answer.");
	if (spec.checker && (spec.checker.type !== "testlib" || !spec.checker.source.trim()))
		addIssue(issues, "INVALID_CHECKER", "checker", "Provide the complete C++ testlib checker source.");
	if (!isSafeFlatName(spec.slug)) {
		addIssue(
			issues,
			"INVALID_SLUG",
			"slug",
			"Use a flat ASCII slug containing letters, numbers, dots, dashes, or underscores.",
		);
	}
	if (spec.title.trim().length === 0) addIssue(issues, "MISSING_TITLE", "title", "A non-empty title is required.");
	if (spec.pid !== undefined && !HYDRO_PID.test(spec.pid)) {
		addIssue(issues, "INVALID_PID", "pid", "A Hydro problem ID must be alphanumeric and cannot contain only digits.");
	}
	if (!SAFE_LANGUAGE.test(spec.language)) {
		addIssue(issues, "INVALID_LANGUAGE", "language", "Use a Hydro language code such as zh or zh_CN.");
	}
	if (spec.statement.trim().length === 0) {
		addIssue(issues, "MISSING_STATEMENT", "statement", "A non-empty Markdown statement is required.");
	}
	validateLimit(issues, spec.timeLimit, "timeLimit", TIME_LIMIT, "Use a positive duration such as 1000ms or 1s.");
	validateLimit(issues, spec.memoryLimit, "memoryLimit", MEMORY_LIMIT, "Use a positive size such as 256m.");

	const tags = new Set<string>();
	for (const [index, tag] of spec.tags.entries()) {
		const normalized = tag.trim();
		if (normalized.length === 0) addIssue(issues, "EMPTY_TAG", `tags[${index}]`, "Tags cannot be empty.");
		if (tags.has(normalized)) addIssue(issues, "DUPLICATE_TAG", `tags[${index}]`, `Duplicate tag: ${normalized}`);
		tags.add(normalized);
	}

	if (spec.subtasks.length === 0) addIssue(issues, "MISSING_SUBTASK", "subtasks", "At least one subtask is required.");
	const subtaskIds = new Set<number>();
	const testFiles = new Set<string>();
	const answerFiles = new Set<string>();
	let totalScore = 0;
	let totalCases = 0;
	for (const [subtaskIndex, subtask] of spec.subtasks.entries()) {
		const subtaskPath = `subtasks[${subtaskIndex}]`;
		if (!Number.isSafeInteger(subtask.id) || subtask.id <= 0) {
			addIssue(issues, "INVALID_SUBTASK_ID", `${subtaskPath}.id`, "Subtask IDs must be positive integers.");
		}
		if (subtaskIds.has(subtask.id)) {
			addIssue(issues, "DUPLICATE_SUBTASK_ID", `${subtaskPath}.id`, `Duplicate subtask ID: ${subtask.id}`);
		}
		subtaskIds.add(subtask.id);
		if (!Number.isSafeInteger(subtask.score) || subtask.score <= 0) {
			addIssue(issues, "INVALID_SUBTASK_SCORE", `${subtaskPath}.score`, "Subtask scores must be positive integers.");
		} else {
			totalScore += subtask.score;
		}
		if (subtask.timeLimit !== undefined) {
			validateLimit(
				issues,
				subtask.timeLimit,
				`${subtaskPath}.timeLimit`,
				TIME_LIMIT,
				"Use a positive duration such as 1s.",
			);
		}
		if (subtask.memoryLimit !== undefined) {
			validateLimit(
				issues,
				subtask.memoryLimit,
				`${subtaskPath}.memoryLimit`,
				MEMORY_LIMIT,
				"Use a positive size such as 256m.",
			);
		}
		if (subtask.cases.length === 0) {
			addIssue(
				issues,
				"EMPTY_SUBTASK",
				`${subtaskPath}.cases`,
				"Every subtask must contain at least one test case.",
			);
		}
		for (const [caseIndex, testCase] of subtask.cases.entries()) {
			totalCases += 1;
			const casePath = `${subtaskPath}.cases[${caseIndex}]`;
			if (problemType === "submit_answer") {
				const input =
					typeof testCase.input === "string" ? testCase.input : new TextDecoder().decode(testCase.input);
				if (spec.answerMode === "multi") {
					const answerFile = input.trim();
					if (!isSafeFlatName(answerFile) || answerFiles.has(answerFile))
						addIssue(
							issues,
							"INVALID_ANSWER_FILE",
							`${casePath}.input`,
							"Each multi-file case must name one unique flat ZIP entry.",
						);
					answerFiles.add(answerFile);
				} else if (input.length > 0)
					addIssue(
						issues,
						"INVALID_SINGLE_ANSWER_INPUT",
						`${casePath}.input`,
						"Single-file answer cases use an empty .in file.",
					);
			}
			for (const [field, fileName] of [
				["inputFile", testCase.inputFile],
				["outputFile", testCase.outputFile],
			] as const) {
				if (!isSafeFlatName(fileName)) {
					addIssue(
						issues,
						"INVALID_TEST_FILE",
						`${casePath}.${field}`,
						"Test data filenames must be flat ASCII names.",
					);
				}
				if (testFiles.has(fileName)) {
					addIssue(
						issues,
						"DUPLICATE_TEST_FILE",
						`${casePath}.${field}`,
						`Duplicate test data filename: ${fileName}`,
					);
				}
				testFiles.add(fileName);
			}
			if (!testCase.inputFile.endsWith(".in")) {
				addIssue(issues, "INVALID_INPUT_EXTENSION", `${casePath}.inputFile`, "Input filenames must end with .in.");
			}
			if (!/\.(?:out|ans)$/.test(testCase.outputFile)) {
				addIssue(
					issues,
					"INVALID_OUTPUT_EXTENSION",
					`${casePath}.outputFile`,
					"Output filenames must end with .out or .ans.",
				);
			}
			if (testCase.timeLimit !== undefined) {
				validateLimit(
					issues,
					testCase.timeLimit,
					`${casePath}.timeLimit`,
					TIME_LIMIT,
					"Use a positive duration such as 1s.",
				);
			}
			if (testCase.memoryLimit !== undefined) {
				validateLimit(
					issues,
					testCase.memoryLimit,
					`${casePath}.memoryLimit`,
					MEMORY_LIMIT,
					"Use a positive size such as 256m.",
				);
			}
		}
	}
	if (problemType === "submit_answer" && spec.answerMode !== "multi" && totalCases !== 1)
		addIssue(
			issues,
			"INVALID_SINGLE_ANSWER_CASES",
			"subtasks",
			"Single-file answer submission requires exactly one complete answer case.",
		);
	if (totalScore !== 100)
		addIssue(issues, "INVALID_TOTAL_SCORE", "subtasks", `Subtask scores total ${totalScore}; expected 100.`);

	for (const [subtaskIndex, subtask] of spec.subtasks.entries()) {
		for (const [dependencyIndex, dependency] of (subtask.dependsOn ?? []).entries()) {
			if (!subtaskIds.has(dependency)) {
				addIssue(
					issues,
					"UNKNOWN_SUBTASK_DEPENDENCY",
					`subtasks[${subtaskIndex}].dependsOn[${dependencyIndex}]`,
					`Unknown subtask ID: ${dependency}`,
				);
			}
			if (dependency === subtask.id) {
				addIssue(
					issues,
					"SELF_SUBTASK_DEPENDENCY",
					`subtasks[${subtaskIndex}].dependsOn[${dependencyIndex}]`,
					"A subtask cannot depend on itself.",
				);
			}
		}
	}
	validateDependencyGraph(spec, issues);

	const attachmentNames = new Set<string>();
	for (const [index, attachment] of (spec.attachments ?? []).entries()) {
		if (!isSafeFlatName(attachment.name)) {
			addIssue(
				issues,
				"INVALID_ATTACHMENT_NAME",
				`attachments[${index}].name`,
				"Attachment names must be flat ASCII names.",
			);
		}
		if (attachmentNames.has(attachment.name)) {
			addIssue(
				issues,
				"DUPLICATE_ATTACHMENT",
				`attachments[${index}].name`,
				`Duplicate attachment: ${attachment.name}`,
			);
		}
		attachmentNames.add(attachment.name);
	}
	for (const reference of extractAttachmentReferences(spec.statement)) {
		if (!attachmentNames.has(reference)) {
			addIssue(
				issues,
				"MISSING_ATTACHMENT",
				"statement",
				`The statement references missing attachment: ${reference}`,
			);
		}
	}

	return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

export class HydroProblemValidationError extends Error {
	readonly report: ValidationReport;

	constructor(report: ValidationReport) {
		super(report.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
		this.name = "HydroProblemValidationError";
		this.report = report;
	}
}

export function assertValidHydroProblemSpec(spec: HydroProblemSpec): void {
	const report = validateHydroProblemSpec(spec);
	if (!report.valid) throw new HydroProblemValidationError(report);
}
