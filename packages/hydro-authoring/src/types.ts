export type HydroSubtaskType = "sum" | "min" | "max";
export type HydroProblemType = "default" | "interactive" | "submit_answer";

export interface HydroTestCase {
	inputFile: string;
	input: string | Uint8Array;
	outputFile: string;
	output: string | Uint8Array;
	timeLimit?: string;
	memoryLimit?: string;
}

export interface HydroSubtask {
	id: number;
	type: HydroSubtaskType;
	score: number;
	dependsOn?: readonly number[];
	timeLimit?: string;
	memoryLimit?: string;
	cases: readonly HydroTestCase[];
}

export interface HydroAttachment {
	name: string;
	content: string | Uint8Array;
}

export interface HydroProblemSpec {
	type?: HydroProblemType;
	multiPass?: number;
	answerMode?: "single" | "multi";
	interactor?: string;
	slug: string;
	title: string;
	pid?: string;
	tags: readonly string[];
	language: string;
	statement: string;
	timeLimit: string;
	memoryLimit: string;
	subtasks: readonly HydroSubtask[];
	attachments?: readonly HydroAttachment[];
	checker?: { type: "testlib"; source: string };
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
	severity: ValidationSeverity;
	code: string;
	path: string;
	message: string;
}

export interface HydroPackageStats {
	statements: number;
	testCases: number;
	attachments: number;
	totalBytes: number;
}

export interface ValidationReport {
	valid: boolean;
	issues: ValidationIssue[];
	stats?: HydroPackageStats;
}

export interface HydroJudgeLimits {
	maxTestCases: number;
	totalTimeLimitMs: number;
}

export interface DirectoryValidationOptions {
	maxFiles?: number;
	maxTotalBytes?: number;
	maxTextFileBytes?: number;
	judgeLimits?: HydroJudgeLimits;
}
