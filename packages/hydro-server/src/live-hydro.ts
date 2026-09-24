import { spawn } from "node:child_process";
import type { ManualProgram } from "./manual-sandbox.ts";

export interface HydroLiveVerificationRequest {
	releaseId: string;
	slug: string;
	packageDirectory: string;
	reference: ManualProgram;
	wrongPrograms: Array<{ name: string; program: ManualProgram }>;
}

export interface HydroLiveSubmissionResult {
	name: string;
	verdict: string;
	score?: number;
	accepted: boolean;
}

export interface HydroLiveVerificationResult {
	success: boolean;
	startedAt: string;
	finishedAt: string;
	problemUrl?: string;
	import: { success: boolean; message: string };
	reference: HydroLiveSubmissionResult;
	wrongPrograms: HydroLiveSubmissionResult[];
	message: string;
}

export interface HydroLiveVerifier {
	status(): { configured: boolean; message: string };
	verify(request: HydroLiveVerificationRequest, signal?: AbortSignal): Promise<HydroLiveVerificationResult>;
}

interface AdapterOutput {
	problemUrl?: unknown;
	import?: unknown;
	reference?: unknown;
	wrongPrograms?: unknown;
}

function submission(value: unknown, fallbackName: string): HydroLiveSubmissionResult {
	if (typeof value !== "object" || value === null) throw new Error(`Hydro 实测缺少 ${fallbackName} 提交结果。`);
	const record = value as Record<string, unknown>;
	if (typeof record.verdict !== "string" || typeof record.accepted !== "boolean")
		throw new Error(`Hydro 实测的 ${fallbackName} 提交结果格式无效。`);
	return {
		name: typeof record.name === "string" ? record.name : fallbackName,
		verdict: record.verdict,
		score: typeof record.score === "number" ? record.score : undefined,
		accepted: record.accepted,
	};
}

function normalizeAdapterOutput(
	value: AdapterOutput,
	request: HydroLiveVerificationRequest,
	startedAt: string,
): HydroLiveVerificationResult {
	if (typeof value.import !== "object" || value.import === null) throw new Error("Hydro 实测适配器未返回导入结果。");
	const imported = value.import as Record<string, unknown>;
	if (typeof imported.success !== "boolean" || typeof imported.message !== "string")
		throw new Error("Hydro 实测导入结果格式无效。");
	const reference = submission(value.reference, "reference");
	if (!Array.isArray(value.wrongPrograms)) throw new Error("Hydro 实测适配器未返回错误程序结果。");
	const expectedWrongNames = request.wrongPrograms.map((item) => item.name);
	const wrongPrograms = value.wrongPrograms.map((item, index) =>
		submission(item, expectedWrongNames[index] ?? `wrong-${index + 1}`),
	);
	if (wrongPrograms.length !== expectedWrongNames.length) throw new Error("Hydro 实测必须提交全部已知错误程序。");
	const referencePassed = reference.accepted && (reference.score === undefined || reference.score === 100);
	const wrongProgramsRejected = wrongPrograms.every((item) => !item.accepted);
	const success = imported.success && referencePassed && wrongProgramsRejected;
	return {
		success,
		startedAt,
		finishedAt: new Date().toISOString(),
		problemUrl: typeof value.problemUrl === "string" ? value.problemUrl : undefined,
		import: { success: imported.success, message: imported.message },
		reference,
		wrongPrograms,
		message: success
			? "Hydro 已成功导入，标程 AC/100，全部已知错误程序均被拒绝。"
			: "Hydro 实测未通过，请检查导入、标程分数和错误程序判定。",
	};
}

export class CommandHydroLiveVerifier implements HydroLiveVerifier {
	private readonly command: string;
	private readonly args: string[];

	constructor(command: string, args: string[] = []) {
		if (!command.trim()) throw new Error("Hydro live verifier command cannot be empty.");
		this.command = command;
		this.args = args;
	}

	status(): { configured: boolean; message: string } {
		return { configured: true, message: `已配置 Hydro 实测适配器：${this.command}` };
	}

	verify(request: HydroLiveVerificationRequest, signal?: AbortSignal): Promise<HydroLiveVerificationResult> {
		const startedAt = new Date().toISOString();
		return new Promise((resolve, reject) => {
			const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let bytes = 0;
			const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
			const abort = (): void => {
				child.kill("SIGKILL");
			};
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				bytes += chunk.byteLength;
				if (bytes > 4 * 1024 * 1024) child.kill("SIGKILL");
				else stdout.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 64 * 1024) stderr.push(chunk);
			});
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) {
					reject(new Error("Hydro 实测已取消。"));
					return;
				}
				if (code !== 0) {
					reject(new Error(Buffer.concat(stderr).toString("utf8").slice(0, 4000) || `适配器退出码 ${code}。`));
					return;
				}
				try {
					const output = JSON.parse(Buffer.concat(stdout).toString("utf8")) as AdapterOutput;
					resolve(normalizeAdapterOutput(output, request, startedAt));
				} catch (error) {
					reject(error);
				}
			});
			child.stdin.end(JSON.stringify({ version: 3, ...request }));
		});
	}
}

export function createHydroLiveVerifierFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): HydroLiveVerifier | undefined {
	const command = environment.HYDRO_LIVE_VERIFY_COMMAND?.trim();
	if (!command) return undefined;
	let args: string[] = [];
	if (environment.HYDRO_LIVE_VERIFY_ARGS) {
		const value = JSON.parse(environment.HYDRO_LIVE_VERIFY_ARGS) as unknown;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
			throw new Error("HYDRO_LIVE_VERIFY_ARGS must be a JSON string array.");
		args = value;
	}
	return new CommandHydroLiveVerifier(command, args);
}
