import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { assertHydroJudgeLimits, DEFAULT_HYDRO_JUDGE_LIMITS, parseHydroTimeLimitMs } from "./judge-limits.ts";
import type {
	DirectoryValidationOptions,
	HydroJudgeLimits,
	HydroPackageStats,
	ValidationIssue,
	ValidationReport,
} from "./types.ts";
import { extractAttachmentReferences, isSafeFlatName, isValidHydroLimit } from "./validation.ts";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const STATEMENT_FILE = /^problem(?:[_.][A-Za-z][A-Za-z0-9_-]*)?\.md$/;
const HYDRO_PID = /^(?![0-9]+$)[A-Za-z0-9]+$/;

interface ScanBudget {
	files: number;
	totalBytes: number;
}

interface FlatDirectory {
	files: Map<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function scanFlatDirectory(
	physicalPath: string,
	logicalPath: string,
	issues: ValidationIssue[],
	budget: ScanBudget,
): Promise<FlatDirectory> {
	const files = new Map<string, number>();
	let entries: Dirent[];
	try {
		entries = await readdir(physicalPath, { withFileTypes: true });
	} catch (error) {
		addIssue(issues, "UNREADABLE_DIRECTORY", logicalPath, `Cannot read directory: ${String(error)}`);
		return { files };
	}
	for (const entry of entries) {
		const entryPath = `${logicalPath}/${entry.name}`;
		if (!isSafeFlatName(entry.name)) {
			addIssue(issues, "UNSAFE_FILENAME", entryPath, "Use a flat ASCII filename with no path separators.");
		}
		if (entry.isSymbolicLink()) {
			addIssue(
				issues,
				"SYMLINK_NOT_ALLOWED",
				entryPath,
				"Symbolic links are not allowed in a generated problem package.",
			);
			continue;
		}
		if (entry.isDirectory()) {
			addIssue(
				issues,
				"NESTED_DIRECTORY",
				entryPath,
				`${logicalPath} must contain files directly, without nested directories.`,
			);
			continue;
		}
		if (!entry.isFile()) {
			addIssue(issues, "UNSUPPORTED_FILE_TYPE", entryPath, "Only regular files are allowed.");
			continue;
		}
		const stats = await lstat(join(physicalPath, entry.name));
		files.set(entry.name, stats.size);
		budget.files += 1;
		budget.totalBytes += stats.size;
	}
	return { files };
}

async function readText(
	path: string,
	logicalPath: string,
	size: number,
	maxBytes: number,
	issues: ValidationIssue[],
): Promise<string | undefined> {
	if (size > maxBytes) {
		addIssue(issues, "TEXT_FILE_TOO_LARGE", logicalPath, `Text file is ${size} bytes; limit is ${maxBytes} bytes.`);
		return undefined;
	}
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		addIssue(issues, "UNREADABLE_FILE", logicalPath, `Cannot read file: ${String(error)}`);
		return undefined;
	}
}

function parseYaml(text: string, logicalPath: string, issues: ValidationIssue[]): unknown {
	const document = parseDocument(text, { uniqueKeys: true });
	for (const error of document.errors) addIssue(issues, "INVALID_YAML", logicalPath, error.message);
	for (const warning of document.warnings) addIssue(issues, "YAML_WARNING", logicalPath, warning.message, "warning");
	if (document.errors.length > 0) return undefined;
	try {
		return document.toJS({ maxAliasCount: 0 });
	} catch (error) {
		addIssue(issues, "UNSAFE_YAML", logicalPath, `Cannot safely resolve YAML: ${String(error)}`);
		return undefined;
	}
}

function validateMetadata(value: unknown, issues: ValidationIssue[]): void {
	if (!isRecord(value)) {
		addIssue(issues, "INVALID_METADATA", "problem.yaml", "Problem metadata must be a YAML mapping.");
		return;
	}
	if (typeof value.title !== "string" || value.title.trim().length === 0) {
		addIssue(issues, "MISSING_TITLE", "problem.yaml.title", "A non-empty title is required.");
	}
	if (value.pid !== undefined && (typeof value.pid !== "string" || !HYDRO_PID.test(value.pid))) {
		addIssue(
			issues,
			"INVALID_PID",
			"problem.yaml.pid",
			"The problem ID must be alphanumeric and cannot contain only digits.",
		);
	}
	if (
		value.tag !== undefined &&
		(!Array.isArray(value.tag) || value.tag.some((tag) => typeof tag !== "string" || tag.trim().length === 0))
	) {
		addIssue(issues, "INVALID_TAGS", "problem.yaml.tag", "Tags must be an array of non-empty strings.");
	}
}

function validateConfig(
	value: unknown,
	testFiles: ReadonlyMap<string, number>,
	issues: ValidationIssue[],
	judgeLimits: HydroJudgeLimits,
): { testCases: number; referencedFiles: Set<string> } {
	const referencedFiles = new Set<string>();
	if (!isRecord(value)) {
		addIssue(issues, "INVALID_CONFIG", "testdata/config.yaml", "Judge configuration must be a YAML mapping.");
		return { testCases: 0, referencedFiles };
	}
	if (value.type !== "default" && value.type !== "interactive" && value.type !== "submit_answer") {
		addIssue(
			issues,
			"UNSUPPORTED_PROBLEM_TYPE",
			"testdata/config.yaml.type",
			"Use type: default, interactive, or submit_answer.",
		);
	}
	if (value.type === "interactive") {
		if (
			typeof value.interactor !== "string" ||
			!isSafeFlatName(value.interactor) ||
			!value.interactor.endsWith(".cc") ||
			!testFiles.get(value.interactor)
		)
			addIssue(
				issues,
				"MISSING_INTERACTOR",
				"testdata/config.yaml.interactor",
				"Provide a referenced C++ interactor source.",
			);
		else referencedFiles.add(value.interactor);
	} else if (value.interactor !== undefined)
		addIssue(
			issues,
			"UNEXPECTED_INTERACTOR",
			"testdata/config.yaml.interactor",
			"Only interactive problems use an interactor.",
		);
	if (
		value.multi_pass !== undefined &&
		(!Number.isInteger(value.multi_pass) ||
			(value.multi_pass as number) < 2 ||
			(value.multi_pass as number) > 20 ||
			value.type !== "interactive")
	)
		addIssue(
			issues,
			"INVALID_MULTI_PASS",
			"testdata/config.yaml.multi_pass",
			"This local pipeline verifies 2–20 passes for interactive problems.",
		);
	if (value.type === "interactive" && value.checker_type !== "default")
		addIssue(
			issues,
			"UNEXPECTED_CHECKER",
			"testdata/config.yaml.checker_type",
			"Interactive problems are scored by the interactor.",
		);
	if (value.type === "submit_answer" && value.subType !== undefined && value.subType !== "multi")
		addIssue(
			issues,
			"INVALID_ANSWER_MODE",
			"testdata/config.yaml.subType",
			"Use subType: multi or omit it for single-file answers.",
		);
	if (value.type !== "submit_answer" && value.subType !== undefined)
		addIssue(
			issues,
			"UNEXPECTED_ANSWER_MODE",
			"testdata/config.yaml.subType",
			"Answer mode is only valid for submit_answer.",
		);
	if (value.checker_type !== "default" && value.checker_type !== "testlib") {
		addIssue(
			issues,
			"UNSUPPORTED_CHECKER",
			"testdata/config.yaml.checker_type",
			"Supported checker types are default and testlib.",
		);
	}
	if (value.checker_type === "testlib") {
		if (typeof value.checker !== "string" || !isSafeFlatName(value.checker) || !value.checker.endsWith(".cc")) {
			addIssue(issues, "INVALID_CHECKER", "testdata/config.yaml.checker", "Use a flat C++ .cc checker filename.");
		} else if (!testFiles.get(value.checker)) {
			addIssue(
				issues,
				"MISSING_CHECKER",
				"testdata/config.yaml.checker",
				"The checker source file is missing or empty.",
			);
		} else referencedFiles.add(value.checker);
	}
	for (const kind of ["time", "memory"] as const) {
		if (!isValidHydroLimit(value[kind], kind))
			addIssue(
				issues,
				"INVALID_LIMIT",
				`testdata/config.yaml.${kind}`,
				`Use an explicit positive ${kind} with Hydro units.`,
			);
	}
	if (value.cases !== undefined) {
		addIssue(
			issues,
			"DEPRECATED_TOP_LEVEL_CASES",
			"testdata/config.yaml.cases",
			"Use subtasks instead of top-level cases.",
		);
	}
	if (!Array.isArray(value.subtasks) || value.subtasks.length === 0) {
		addIssue(
			issues,
			"MISSING_SUBTASKS",
			"testdata/config.yaml.subtasks",
			"At least one explicit subtask is required.",
		);
		return { testCases: 0, referencedFiles };
	}

	const subtaskIds = new Set<number>();
	const dependencies: Array<{ path: string; ids: number[] }> = [];
	let totalScore = 0;
	let testCases = 0;
	let totalTimeMs = 0;
	for (const [subtaskIndex, subtask] of value.subtasks.entries()) {
		const subtaskPath = `testdata/config.yaml.subtasks[${subtaskIndex}]`;
		if (!isRecord(subtask)) {
			addIssue(issues, "INVALID_SUBTASK", subtaskPath, "Subtask entries must be YAML mappings.");
			continue;
		}
		for (const kind of ["time", "memory"] as const) {
			if (subtask[kind] !== undefined && !isValidHydroLimit(subtask[kind], kind))
				addIssue(issues, "INVALID_LIMIT", `${subtaskPath}.${kind}`, `Use a positive ${kind} with Hydro units.`);
		}
		if (!Number.isSafeInteger(subtask.id) || (subtask.id as number) <= 0) {
			addIssue(issues, "INVALID_SUBTASK_ID", `${subtaskPath}.id`, "Use an explicit positive integer ID.");
		} else if (subtaskIds.has(subtask.id as number)) {
			addIssue(issues, "DUPLICATE_SUBTASK_ID", `${subtaskPath}.id`, `Duplicate subtask ID: ${subtask.id}`);
		} else {
			subtaskIds.add(subtask.id as number);
		}
		if (!Number.isSafeInteger(subtask.score) || (subtask.score as number) <= 0) {
			addIssue(issues, "INVALID_SUBTASK_SCORE", `${subtaskPath}.score`, "Use an explicit positive integer score.");
		} else {
			totalScore += subtask.score as number;
		}
		if (subtask.type !== "sum" && subtask.type !== "min" && subtask.type !== "max") {
			addIssue(
				issues,
				"UNSUPPORTED_SUBTASK_TYPE",
				`${subtaskPath}.type`,
				"Use sum for point scoring, min for bundled scoring, or max for best-case scoring.",
			);
		}
		if (subtask.if !== undefined) {
			if (!Array.isArray(subtask.if) || subtask.if.some((id) => !Number.isSafeInteger(id))) {
				addIssue(
					issues,
					"INVALID_SUBTASK_DEPENDENCY",
					`${subtaskPath}.if`,
					"Subtask dependencies must be an array of integer IDs.",
				);
			} else {
				dependencies.push({ path: `${subtaskPath}.if`, ids: subtask.if as number[] });
			}
		}
		if (!Array.isArray(subtask.cases) || subtask.cases.length === 0) {
			addIssue(
				issues,
				"EMPTY_SUBTASK",
				`${subtaskPath}.cases`,
				"Every subtask must contain at least one test case.",
			);
			continue;
		}
		for (const [caseIndex, testCase] of subtask.cases.entries()) {
			const casePath = `${subtaskPath}.cases[${caseIndex}]`;
			if (!isRecord(testCase)) {
				addIssue(issues, "INVALID_TEST_CASE", casePath, "Test case entries must be YAML mappings.");
				continue;
			}
			const effectiveTime = parseHydroTimeLimitMs(testCase.time ?? subtask.time ?? value.time);
			if (effectiveTime !== undefined) totalTimeMs += effectiveTime;
			for (const kind of ["time", "memory"] as const) {
				if (testCase[kind] !== undefined && !isValidHydroLimit(testCase[kind], kind))
					addIssue(issues, "INVALID_LIMIT", `${casePath}.${kind}`, `Use a positive ${kind} with Hydro units.`);
			}
			let completeCase = true;
			for (const field of ["input", "output"] as const) {
				const fileName = testCase[field];
				if (typeof fileName !== "string" || !isSafeFlatName(fileName)) {
					addIssue(issues, "INVALID_TEST_FILE", `${casePath}.${field}`, "Use a flat ASCII filename.");
					completeCase = false;
					continue;
				}
				if (referencedFiles.has(fileName)) {
					addIssue(
						issues,
						"DUPLICATE_TEST_REFERENCE",
						`${casePath}.${field}`,
						`Test data file is referenced more than once: ${fileName}`,
					);
				}
				referencedFiles.add(fileName);
				if (!testFiles.has(fileName)) {
					addIssue(issues, "MISSING_TEST_FILE", `${casePath}.${field}`, `Missing test data file: ${fileName}`);
				}
			}
			if (completeCase) testCases += 1;
		}
	}
	if (testCases > judgeLimits.maxTestCases)
		addIssue(
			issues,
			"TOO_MANY_TEST_CASES",
			"testdata/config.yaml.subtasks",
			`Hydro judge accepts at most ${judgeLimits.maxTestCases} test cases; found ${testCases}.`,
		);
	if (totalTimeMs > judgeLimits.totalTimeLimitMs)
		addIssue(
			issues,
			"TOTAL_TIME_LIMIT_EXCEEDED",
			"testdata/config.yaml.subtasks",
			`Hydro judge total time limit is ${judgeLimits.totalTimeLimitMs} ms; cases sum to ${totalTimeMs} ms.`,
		);
	if (totalScore !== 100) {
		addIssue(
			issues,
			"INVALID_TOTAL_SCORE",
			"testdata/config.yaml.subtasks",
			`Subtask scores total ${totalScore}; expected 100.`,
		);
	}
	for (const dependency of dependencies) {
		for (const id of dependency.ids) {
			if (!subtaskIds.has(id))
				addIssue(issues, "UNKNOWN_SUBTASK_DEPENDENCY", dependency.path, `Unknown subtask ID: ${id}`);
		}
	}
	return { testCases, referencedFiles };
}

export async function validateHydroDirectory(
	problemDirectory: string,
	options: DirectoryValidationOptions = {},
): Promise<ValidationReport> {
	const issues: ValidationIssue[] = [];
	const budget: ScanBudget = { files: 0, totalBytes: 0 };
	const root = resolve(problemDirectory);
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const maxTextFileBytes = options.maxTextFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES;
	const judgeLimits = options.judgeLimits ?? DEFAULT_HYDRO_JUDGE_LIMITS;
	assertHydroJudgeLimits(judgeLimits);

	let rootEntries: Dirent[];
	try {
		const rootStats = await lstat(root);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
			return {
				valid: false,
				issues: [
					{
						severity: "error",
						code: "INVALID_ROOT",
						path: ".",
						message: "Problem package root must be a real directory.",
					},
				],
			};
		}
		rootEntries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		return {
			valid: false,
			issues: [
				{
					severity: "error",
					code: "UNREADABLE_ROOT",
					path: ".",
					message: `Cannot read problem package: ${String(error)}`,
				},
			],
		};
	}

	const rootFiles = new Map<string, number>();
	const rootDirectories = new Set<string>();
	for (const entry of rootEntries) {
		if (entry.isSymbolicLink()) {
			addIssue(
				issues,
				"SYMLINK_NOT_ALLOWED",
				entry.name,
				"Symbolic links are not allowed in a generated problem package.",
			);
			continue;
		}
		if (entry.isDirectory()) {
			rootDirectories.add(entry.name);
			if (entry.name === "std" || entry.name === "solution") {
				addIssue(
					issues,
					"IMPORT_SIDE_EFFECT_DIRECTORY",
					entry.name,
					`${entry.name}/ has import side effects and is excluded from release packages.`,
				);
			} else if (entry.name !== "testdata" && entry.name !== "additional_file") {
				addIssue(
					issues,
					"UNEXPECTED_ROOT_DIRECTORY",
					entry.name,
					"Unexpected root directory; release packages use a strict allowlist.",
				);
			}
			continue;
		}
		if (!entry.isFile()) {
			addIssue(issues, "UNSUPPORTED_FILE_TYPE", entry.name, "Only regular files are allowed.");
			continue;
		}
		const stats = await lstat(join(root, entry.name));
		rootFiles.set(entry.name, stats.size);
		budget.files += 1;
		budget.totalBytes += stats.size;
		if (entry.name !== "problem.yaml" && !STATEMENT_FILE.test(entry.name)) {
			addIssue(
				issues,
				"UNEXPECTED_ROOT_FILE",
				entry.name,
				"Unexpected root file; release packages use a strict allowlist.",
			);
		}
	}

	if (!rootFiles.has("problem.yaml")) addIssue(issues, "MISSING_METADATA", "problem.yaml", "Missing problem.yaml.");
	const statementFiles = [...rootFiles.keys()].filter((name) => STATEMENT_FILE.test(name)).sort();
	if (statementFiles.length === 0)
		addIssue(issues, "MISSING_STATEMENT", "problem_*.md", "At least one problem statement is required.");
	if (!rootDirectories.has("testdata"))
		addIssue(issues, "MISSING_TESTDATA", "testdata", "Missing testdata directory.");

	const testdata = rootDirectories.has("testdata")
		? await scanFlatDirectory(join(root, "testdata"), "testdata", issues, budget)
		: { files: new Map<string, number>() };
	const attachments = rootDirectories.has("additional_file")
		? await scanFlatDirectory(join(root, "additional_file"), "additional_file", issues, budget)
		: { files: new Map<string, number>() };

	const metadataSize = rootFiles.get("problem.yaml");
	if (metadataSize !== undefined) {
		const text = await readText(join(root, "problem.yaml"), "problem.yaml", metadataSize, maxTextFileBytes, issues);
		if (text !== undefined) validateMetadata(parseYaml(text, "problem.yaml", issues), issues);
	}

	let testCases = 0;
	const configSize = testdata.files.get("config.yaml");
	let referencedTestFiles = new Set<string>();
	if (configSize === undefined) {
		addIssue(issues, "MISSING_CONFIG", "testdata/config.yaml", "Missing explicit judge configuration.");
	} else {
		const text = await readText(
			join(root, "testdata", "config.yaml"),
			"testdata/config.yaml",
			configSize,
			maxTextFileBytes,
			issues,
		);
		if (text !== undefined) {
			const parsed = parseYaml(text, "testdata/config.yaml", issues);
			const result = validateConfig(parsed, testdata.files, issues, judgeLimits);
			testCases = result.testCases;
			referencedTestFiles = result.referencedFiles;
			if (isRecord(parsed) && parsed.type === "submit_answer" && Array.isArray(parsed.subtasks)) {
				const answerFiles = new Set<string>();
				for (const subtask of parsed.subtasks) {
					if (!isRecord(subtask) || !Array.isArray(subtask.cases)) continue;
					for (const item of subtask.cases) {
						if (!isRecord(item) || typeof item.input !== "string" || !testdata.files.has(item.input)) continue;
						const input = await readText(
							join(root, "testdata", item.input),
							`testdata/${item.input}`,
							testdata.files.get(item.input) ?? 0,
							maxTextFileBytes,
							issues,
						);
						if (input === undefined) continue;
						if (parsed.subType === "multi") {
							const answerFile = input.trim();
							if (!isSafeFlatName(answerFile) || answerFiles.has(answerFile))
								addIssue(
									issues,
									"INVALID_ANSWER_FILE",
									`testdata/${item.input}`,
									"Each multi-file case must name one unique flat ZIP entry.",
								);
							answerFiles.add(answerFile);
						} else if (input.length > 0)
							addIssue(
								issues,
								"INVALID_SINGLE_ANSWER_INPUT",
								`testdata/${item.input}`,
								"Single-file answer cases use an empty .in file.",
							);
					}
				}
				if (parsed.subType !== "multi" && testCases !== 1)
					addIssue(
						issues,
						"INVALID_SINGLE_ANSWER_CASES",
						"testdata/config.yaml.subtasks",
						"Single-file answer submission requires exactly one case.",
					);
			}
		}
	}
	for (const fileName of testdata.files.keys()) {
		if (fileName !== "config.yaml" && /\.(?:in|out|ans)$/.test(fileName) && !referencedTestFiles.has(fileName)) {
			addIssue(
				issues,
				"UNREFERENCED_TEST_FILE",
				`testdata/${fileName}`,
				"Test data file is not referenced by config.yaml.",
				"warning",
			);
		}
	}

	for (const statementFile of statementFiles) {
		const size = rootFiles.get(statementFile)!;
		const statement = await readText(join(root, statementFile), statementFile, size, maxTextFileBytes, issues);
		if (statement === undefined) continue;
		if (statement.trim().length === 0)
			addIssue(issues, "EMPTY_STATEMENT", statementFile, "Problem statement cannot be empty.");
		for (const reference of extractAttachmentReferences(statement)) {
			if (!attachments.files.has(reference)) {
				addIssue(
					issues,
					"MISSING_ATTACHMENT",
					statementFile,
					`Statement references missing attachment: ${reference}`,
				);
			}
		}
	}

	if (budget.files > maxFiles)
		addIssue(issues, "TOO_MANY_FILES", ".", `Package contains ${budget.files} files; limit is ${maxFiles}.`);
	if (budget.totalBytes > maxTotalBytes) {
		addIssue(
			issues,
			"PACKAGE_TOO_LARGE",
			".",
			`Package is ${budget.totalBytes} bytes; limit is ${maxTotalBytes} bytes.`,
		);
	}
	const stats: HydroPackageStats = {
		statements: statementFiles.length,
		testCases,
		attachments: attachments.files.size,
		totalBytes: budget.totalBytes,
	};
	return { valid: !issues.some((issue) => issue.severity === "error"), issues, stats };
}
