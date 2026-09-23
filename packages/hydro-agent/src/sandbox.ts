import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { compareHydroDefaultOutput } from "@hydro-problem-make/authoring";
import {
	type HydroAuthoringProject,
	type HydroAuthoringReport,
	type HydroAuthoringVerificationMode,
	validateAuthoringProject,
} from "./authoring-project.ts";
import { authoringRunner } from "./authoring-runner.ts";
import { sandboxRunner } from "./sandbox-runner.ts";

export type HydroProgramLanguage = "cpp17" | "python3" | "java";
export interface HydroReferenceProgram {
	language: HydroProgramLanguage;
	code: string;
}

export interface HydroSandboxCase {
	input: string;
	expectedOutput?: string;
}

export interface HydroSandboxRequest {
	program: HydroReferenceProgram;
	cases: HydroSandboxCase[];
	timeLimitMs?: number;
	memoryLimitMb?: number;
}

export interface HydroSandboxCaseResult {
	index: number;
	status: "generated" | "passed" | "wrong_answer" | "runtime_error" | "time_limit" | "output_limit";
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

export interface HydroSandboxReport {
	success: boolean;
	compiled: boolean;
	compileOutput: string;
	cases: HydroSandboxCaseResult[];
}

export interface HydroSandboxStatus {
	available: boolean;
	image: string;
	message: string;
}

export interface HydroSandbox {
	status(): Promise<HydroSandboxStatus>;
	run(request: HydroSandboxRequest, signal?: AbortSignal): Promise<HydroSandboxReport>;
	verifyProject?(
		project: HydroAuthoringProject,
		options?: { mode?: HydroAuthoringVerificationMode; signal?: AbortSignal },
	): Promise<HydroAuthoringReport>;
}

function docker(args: string[], input = "", timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errors: Buffer[] = [];
		let total = 0;
		let failure: Error | undefined;
		const stop = (message: string): void => {
			failure = new Error(message);
			child.kill("SIGKILL");
		};
		const abort = (): void => stop("沙箱执行已取消。");
		const timer = setTimeout(() => stop("沙箱执行超过总时间限制。"), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > 128 * 1024 * 1024) stop("沙箱输出超过 128 MiB。");
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (errors.length < 32) errors.push(chunk);
		});
		child.stdin.on("error", () => {
			/* A terminated container can close stdin before the client. */
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(new Error(Buffer.concat(errors).toString("utf8").slice(0, 4000) || `Docker exited with ${code}.`));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		if (signal?.aborted) abort();
		else child.stdin.end(input);
	});
}

export class DockerHydroSandbox implements HydroSandbox {
	readonly image: string;
	constructor(image = "hydro-problem-make/sandbox:local") {
		this.image = image;
	}

	async status(): Promise<HydroSandboxStatus> {
		try {
			await docker(["info", "--format", "{{.ServerVersion}}"]);
			await docker(["image", "inspect", this.image, "--format", "{{.Id}}"]);
			return { available: true, image: this.image, message: "Linux 沙箱可用 · C++17 / Python 3 / Java · testlib" };
		} catch (error) {
			return {
				available: false,
				image: this.image,
				message: error instanceof Error ? error.message : "Docker 不可用。",
			};
		}
	}

	async run(request: HydroSandboxRequest, signal?: AbortSignal): Promise<HydroSandboxReport> {
		if (!["cpp17", "python3", "java"].includes(request.program.language) || !request.program.code.trim())
			throw new Error("请选择语言并添加标准程序。");
		if (request.program.code.length > 200_000) throw new Error("标准程序超过 200000 字符。");
		if (request.cases.length < 1 || request.cases.length > 100) throw new Error("每次运行需要 1–100 个测试点。");
		const timeLimitMs = request.timeLimitMs ?? 2000;
		const memoryLimitMb = request.memoryLimitMb ?? 256;
		if (!Number.isInteger(timeLimitMs) || timeLimitMs < 50 || timeLimitMs > 10000)
			throw new Error("时间限制须为 50–10000 ms。");
		if (!Number.isInteger(memoryLimitMb) || memoryLimitMb < 32 || memoryLimitMb > 512)
			throw new Error("内存限制须为 32–512 MiB。");
		const raw = await this.execute(
			sandboxRunner,
			{ ...request, timeLimitMs, memoryLimitMb },
			45000 + request.cases.length * (timeLimitMs + 1000),
			signal,
		);
		const result = JSON.parse(raw) as {
			compiled: boolean;
			compileOutput: string;
			cases: Array<Omit<HydroSandboxCaseResult, "status"> & { status: "ok" | HydroSandboxCaseResult["status"] }>;
		};
		const cases: HydroSandboxCaseResult[] = result.cases.map((item) => {
			const expected = request.cases[item.index]?.expectedOutput;
			const status =
				item.status !== "ok"
					? item.status
					: expected === undefined
						? "generated"
						: compareHydroDefaultOutput(expected, item.stdout).equal
							? "passed"
							: "wrong_answer";
			return { ...item, status };
		});
		return {
			...result,
			cases,
			success:
				result.compiled &&
				cases.length === request.cases.length &&
				cases.every((item) => item.status === "passed" || item.status === "generated"),
		};
	}

	async verifyProject(
		project: HydroAuthoringProject,
		options: { mode?: HydroAuthoringVerificationMode; signal?: AbortSignal } = {},
	): Promise<HydroAuthoringReport> {
		validateAuthoringProject(project);
		const report = JSON.parse(
			await this.execute(
				authoringRunner,
				{ ...project, verificationMode: options.mode ?? "full" },
				900_000,
				options.signal,
			),
		) as HydroAuthoringReport;
		return { ...report, toolchain: { ...report.toolchain, sandboxImage: this.image } };
	}

	private async execute(runner: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		const name = `hydro-sandbox-${randomUUID()}`;
		try {
			return await docker(
				[
					"run",
					"--rm",
					"-i",
					"--name",
					name,
					"--network",
					"none",
					"--cpus",
					"1",
					"--memory",
					"1g",
					"--memory-swap",
					"1g",
					"--pids-limit",
					"128",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--user",
					"65534:65534",
					"--tmpfs",
					"/work:rw,exec,size=256m,mode=1777",
					"--tmpfs",
					"/tmp:rw,exec,size=64m,mode=1777",
					"--workdir",
					"/work",
					"--entrypoint",
					"python3",
					this.image,
					"-c",
					runner,
				],
				JSON.stringify(payload),
				timeoutMs,
				signal,
			);
		} catch (error) {
			await docker(["rm", "-f", name]).catch(() => {});
			throw error;
		}
	}
}
