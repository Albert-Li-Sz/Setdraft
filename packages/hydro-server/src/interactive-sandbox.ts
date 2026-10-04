import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	communicationCompileStandard,
	type ManualCheck,
	type ManualProgram,
	type ManualSandboxReport,
} from "@setdraft/contracts";
import { checkerRatio, checkerScore } from "./checker-protocol.ts";
import {
	communicationAdapter,
	readCommunicationEnvelope,
	readCommunicationInitialInput,
} from "./communication-adapter.ts";
import { sandboxGeneratorCommands, sandboxGenerators } from "./generator-sandbox.ts";
import type { SandboxCase, SandboxInput } from "./manual-sandbox.ts";
import { pythonProcessMonitor } from "./process-monitor.ts";
import { readSandboxFile } from "./sandbox-files.ts";
import { sandboxPolicy } from "./sandbox-policy.ts";
import { removeDockerContainer, SandboxCleanupError, sandboxRuntimeArgs } from "./sandbox-runtime.ts";

const roles = ["reference", "oracle", "interactor", "validator", "generator"] as const;
type Role = (typeof roles)[number] | `candidate${number}` | `generator${number}`;
const captureLimit = 64 * 1024;
const readyMarker = "SETDRAFT_INTERACTIVE_READY\n";
const contestantExitCodes = { TLE: 124, MLE: 125, RE: 126 } as const;
const launcher = String.raw`import json, math, os, pathlib, resource, signal, subprocess, sys, time
timeout, memory, file_limit = map(int, sys.argv[1:4])
role = sys.argv[4]
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(timeout / 1000) + 1, math.ceil(timeout / 1000) + 1))
${pythonProcessMonitor}
os.chdir('/tmp')
os.write(2, b'SETDRAFT_INTERACTIVE_READY\n')
if os.read(0, 1) != b'\n': sys.exit(125)
process = subprocess.Popen(sys.argv[5:], start_new_session=True,
    env={'PATH':'/usr/local/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'LC_ALL':'C.UTF-8', 'TZ':'UTC', 'HOME':'/tmp'})
path = pathlib.Path('/metrics/result.json')
def sample(peak):
    if path.parent.exists(): path.write_text(json.dumps({'memoryBytes':peak}))
result = wait_program(process, timeout / 1000, memory or None, sample)
if path.parent.exists(): path.write_text(json.dumps(result))
if role == 'contestant':
    sys.exit({'ok':0, 'time_limit':${contestantExitCodes.TLE}, 'memory_limit':${contestantExitCodes.MLE}, 'runtime_error':${contestantExitCodes.RE}}[result['status']])
sys.exit(0 if result['status'] == 'ok' else result['code'] if result['code'] > 0 else 1)
`;

export function interactiveContainerNames(taskId: string): string[] {
	return [
		...roles,
		...Array.from({ length: 32 }, (_, index) => `candidate${index}`),
		...Array.from({ length: 32 }, (_, index) => `generator${index}`),
	].map((role) => `setdraft-task-${taskId}-${role}`);
}

function docker(
	args: string[],
	timeout = 30_000,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
		let stdout = "";
		let stderr = "";
		const abort = () => {
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString()).slice(0, captureLimit);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(0, captureLimit);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			signal?.removeEventListener("abort", abort);
			resolve({ code: code ?? 125, stdout, stderr });
		});
		if (signal?.aborted) abort();
	});
}

async function containerState(name: string): Promise<{ running: boolean; exitCode: number; oomKilled: boolean }> {
	const inspected = await docker(["inspect", "--format", "{{json .State}}", name]);
	if (inspected.code !== 0) throw new Error(inspected.stderr || "无法读取交互容器状态。");
	const state: unknown = JSON.parse(inspected.stdout);
	if (
		!state ||
		typeof state !== "object" ||
		!("Running" in state) ||
		typeof state.Running !== "boolean" ||
		!("ExitCode" in state) ||
		typeof state.ExitCode !== "number" ||
		!Number.isSafeInteger(state.ExitCode) ||
		!("OOMKilled" in state) ||
		typeof state.OOMKilled !== "boolean"
	)
		throw new Error("交互容器状态不完整。");
	return { running: state.Running, exitCode: state.ExitCode, oomKilled: state.OOMKilled };
}

async function remove(names: string[], stage?: string): Promise<void> {
	if (!names.length) return;
	const results = await Promise.allSettled(names.map(removeDockerContainer));
	if (results.some((result) => result.status === "rejected"))
		throw new SandboxCleanupError(names, stage ? [stage] : []);
}

interface Program {
	role: Role;
	directory: string;
	language: ManualProgram["language"];
	command: string[];
}

export interface InteractorAdapter {
	source?: string;
	communicationInputEnvelope?: boolean;
	build: string;
	run: string;
	testlibPath: string;
}

function buildCommand(language: ManualProgram["language"]): string[] {
	if (language.startsWith("cpp"))
		return [
			"g++",
			`-std=c++${language.slice(3)}`,
			"-O2",
			"-pipe",
			"-I/opt/testlib",
			"/program/main.cc",
			"-o",
			"/program/main",
		];
	return language === "java"
		? ["javac", "-J-Xmx256m", "/program/Main.java"]
		: ["python3", "-m", "py_compile", "/program/main.py"];
}

function programCommand(language: ManualProgram["language"], memory: number): string[] {
	if (language.startsWith("cpp")) return ["/program/main"];
	return language === "java"
		? ["java", `-Xmx${memory}m`, "-XX:ActiveProcessorCount=1", "-XX:+UseSerialGC", "-cp", "/program", "Main"]
		: ["python3", "-I", "/program/main.py"];
}

interface Participant {
	process: ChildProcessWithoutNullStreams;
	ready: boolean;
	closed: boolean;
	code: number | null;
	stderr: string;
	output: Buffer[];
	bytes: number;
	completion: Promise<void>;
}

async function runSingle(
	input: SandboxInput,
	taskId: string,
	program: Program,
	args: string[],
	data = Buffer.alloc(0),
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
	const name = `setdraft-task-${taskId}-${program.role}`;
	input.context?.signal.throwIfAborted();
	try {
		const created = await docker([
			"create",
			"--interactive",
			"--name",
			name,
			...sandboxRuntimeArgs(),
			"--mount",
			`type=bind,source=${program.directory},target=/program,readonly`,
			"--mount",
			`type=bind,source=${join(input.stage, "launcher.py")},target=/launcher.py,readonly`,
			"--workdir",
			"/tmp",
			"--entrypoint",
			"python3",
			input.image,
			"/launcher.py",
			"30000",
			"512",
			String(input.maxFileBytes),
			"auxiliary",
			...program.command,
			...args,
		]);
		if (created.code !== 0) throw new Error(created.stderr);
		input.context?.signal.throwIfAborted();
		return await new Promise((resolve, reject) => {
			const child = spawn("docker", ["start", "--attach", "--interactive", name], { stdio: "pipe" });
			const chunks: Buffer[] = [];
			let bytes = 0;
			let stderr = "";
			let failure = "";
			const stop = (reason: string) => {
				failure = reason;
				child.kill("SIGKILL");
			};
			const abort = () => stop("任务已取消。");
			const timer = setTimeout(() => stop("程序超时。"), 45_000);
			input.context?.signal.addEventListener("abort", abort, { once: true });
			child.stdin.on("error", () => {});
			child.stdin.end(Buffer.concat([Buffer.from("\n"), data]));
			child.stdout.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > input.maxFileBytes) stop("程序输出超限。");
				else chunks.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(0, captureLimit + 1);
				if (stderr.length > captureLimit) stop("程序诊断输出超限。");
			});
			child.once("error", reject);
			child.once("close", (code) => {
				clearTimeout(timer);
				input.context?.signal.removeEventListener("abort", abort);
				resolve({
					code: failure ? 125 : (code ?? 125),
					stdout: Buffer.concat(chunks),
					stderr: failure || stderr.replace(readyMarker, ""),
				});
			});
			if (input.context?.signal.aborted) abort();
		});
	} finally {
		await remove([name], input.stage);
	}
}

async function dialogue(
	input: SandboxInput,
	taskId: string,
	contestant: Program,
	jury: Program,
	test: SandboxCase,
	adapted: boolean,
	round?: 1 | 2,
	generation = false,
): Promise<ManualCheck> {
	const policy = sandboxPolicy();
	const juryMemory = 512;
	const contestantMemory = input.memoryLimitMb + (contestant.language === "java" ? 256 : 64);
	if (juryMemory + contestantMemory > policy.memoryMb)
		throw new Error(`交互任务需要至少 ${juryMemory + contestantMemory} MiB 沙箱内存预算。`);
	const directory = join(input.stage, "jury", `${contestant.role}-${test.id}`);
	await rm(directory, { recursive: true, force: true });
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o777);
	await copyFile(test.inputPath, join(directory, "input.in"));
	if (test.outputPath) await copyFile(test.outputPath, join(directory, "answer.ans"));
	else await writeFile(join(directory, "answer.ans"), "");
	await chmod(join(directory, "input.in"), 0o444);
	await chmod(join(directory, "answer.ans"), generation ? 0o666 : 0o444);
	const names = [contestant, jury].map((program) => `setdraft-task-${taskId}-${program.role}`);
	const participants: Participant[] = [];
	try {
		for (const [index, program] of [contestant, jury].entries()) {
			input.context?.signal.throwIfAborted();
			const isJury = index === 1;
			const memory = isJury ? juryMemory : contestantMemory;
			const metrics = join(input.stage, "metrics", `${program.role}-${test.id}`);
			await rm(metrics, { recursive: true, force: true });
			await mkdir(metrics, { recursive: true });
			await chmod(metrics, 0o777);
			const command = [
				...program.command,
				...(isJury
					? adapted
						? ["/jury/input.in", "/jury/answer.ans", "/jury"]
						: [
								"/jury/input.in",
								"/jury/transcript",
								"/jury/answer.ans",
								...(round ? [String(round), ...(generation ? ["generate"] : [])] : []),
							]
					: []),
			];
			const result = await docker([
				"create",
				"--interactive",
				"--name",
				names[index],
				...sandboxRuntimeArgs({ ...policy, cpus: policy.cpus / 2, memoryMb: memory }),
				"--mount",
				`type=bind,source=${program.directory},target=/program,readonly`,
				"--mount",
				`type=bind,source=${join(input.stage, "launcher.py")},target=/launcher.py,readonly`,
				...(isJury ? ["--mount", `type=bind,source=${directory},target=/jury`] : []),
				"--mount",
				`type=bind,source=${metrics},target=/metrics`,
				"--workdir",
				"/tmp",
				"--entrypoint",
				"python3",
				input.image,
				"/launcher.py",
				String(input.timeLimitMs),
				String(isJury ? juryMemory : input.memoryLimitMb),
				String(input.maxFileBytes),
				isJury ? "jury" : "contestant",
				...command,
			]);
			if (result.code !== 0) throw new Error(result.stderr || "无法创建交互容器。");
		}
		input.context?.signal.throwIfAborted();
		const result = await new Promise<ManualCheck>((resolve) => {
			let started = 0;
			let settled = false;
			let timer: NodeJS.Timeout;
			const finish = (verdict: ManualCheck["verdict"], message: string, score?: number, scoreRatio?: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				input.context?.signal.removeEventListener("abort", abort);
				resolve({
					stage: `interaction:${contestant.role}`,
					caseId: test.id,
					passed: verdict === "AC",
					verdict,
					message: message.slice(0, 3000),
					score,
					scoreRatio,
					durationMs: started ? Date.now() - started : 0,
				});
			};
			const abort = () => finish("SYSTEM_ERROR", "交互验证已取消。");
			timer = setTimeout(() => finish("SYSTEM_ERROR", "交互容器启动超时。"), 30_000);
			input.context?.signal.addEventListener("abort", abort, { once: true });
			const assess = () => {
				const [team, interactor] = participants;
				if (!team || !interactor) return;
				if (interactor.closed) {
					const message = interactor.stderr.trim();
					const score = checkerScore(interactor.code, interactor.stderr, adapted);
					if (score === undefined) finish("SYSTEM_ERROR", `交互器错误（${interactor.code}）：${message}`);
					else if (team.closed && team.code !== 0) finish("RE", `选手程序异常退出：${team.stderr}`, 0);
					else if (score !== 100 || team.closed)
						finish(
							score === 100 ? "AC" : "WA",
							message,
							score,
							checkerRatio(interactor.code, interactor.stderr, adapted),
						);
				}
			};
			for (const [index, name] of names.entries()) {
				const child = spawn("docker", ["start", "--attach", "--interactive", name], { stdio: "pipe" });
				const completion = new Promise<void>((done) => {
					child.once("close", () => done());
				});
				const participant: Participant = {
					process: child,
					ready: false,
					closed: false,
					code: null,
					stderr: "",
					output: [],
					bytes: 0,
					completion,
				};
				participants.push(participant);
				child.stdin.on("error", () => {});
				child.stderr.on("data", (chunk: Buffer) => {
					participant.stderr = (participant.stderr + chunk.toString()).slice(0, captureLimit + 1);
					if (participant.stderr.length > captureLimit)
						finish(index === 0 ? "RE" : "SYSTEM_ERROR", "诊断输出超限。");
					if (!participant.ready && participant.stderr.startsWith(readyMarker)) {
						participant.ready = true;
						participant.stderr = participant.stderr.slice(readyMarker.length);
						if (participants.length === 2 && participants.every((item) => item.ready)) {
							started = Date.now();
							clearTimeout(timer);
							timer = setTimeout(() => {
								const team = participants[0];
								finish(
									team.closed ? (team.code !== 0 ? "RE" : "SYSTEM_ERROR") : "TLE",
									team.closed
										? team.code !== 0
											? `选手程序异常退出：${team.stderr}`
											: "选手程序已结束，裁判未在时限内完成判定。"
										: "交互超时：检查 flush、通信协议或双方等待。",
								);
							}, input.timeLimitMs);
							for (const item of participants) item.process.stdin.write("\n");
						}
					}
				});
				child.stdout.on("data", (chunk: Buffer) => {
					const previous = participant.bytes;
					participant.bytes += chunk.byteLength;
					if (previous < captureLimit) participant.output.push(chunk.subarray(0, captureLimit - previous));
					if (participant.bytes > input.maxFileBytes) {
						finish(index === 0 ? "RE" : "SYSTEM_ERROR", index === 0 ? "选手输出超限。" : "交互器输出超限。");
						return;
					}
					const peer = participants[1 - index];
					if (
						!settled &&
						peer &&
						!peer.closed &&
						!peer.process.stdin.destroyed &&
						!peer.process.stdin.write(chunk)
					) {
						child.stdout.pause();
						peer.process.stdin.once("drain", () => child.stdout.resume());
					}
				});
				child.stdout.once("end", () => {
					participants[1 - index]?.process.stdin.end();
				});
				child.once("error", (error) => finish("SYSTEM_ERROR", error.message));
				child.once("close", (code) => {
					participant.closed = true;
					participant.code = code;
					if (!participant.ready) finish("SYSTEM_ERROR", participant.stderr || "交互容器未启动。");
					else assess();
				});
			}
			if (input.context?.signal.aborted) abort();
		});
		const metrics = await readFile(
			join(input.stage, "metrics", `${contestant.role}-${test.id}`, "result.json"),
			"utf8",
		).catch(() => "{}");
		let memoryBytes: number | undefined;
		let memoryExceeded = false;
		try {
			const value: unknown = JSON.parse(metrics);
			if (
				value &&
				typeof value === "object" &&
				"memoryBytes" in value &&
				typeof value.memoryBytes === "number" &&
				Number.isSafeInteger(value.memoryBytes) &&
				value.memoryBytes >= 0
			) {
				memoryBytes = value.memoryBytes;
				memoryExceeded = value.memoryBytes > input.memoryLimitMb * 1048576;
			}
		} catch {}
		const states = await Promise.all(names.map(containerState));
		if (states[1].oomKilled)
			return {
				...result,
				passed: false,
				verdict: "SYSTEM_ERROR",
				score: 0,
				scoreRatio: 0,
				message: "Interactor 容器内存超限。",
				memoryBytes,
			};
		if (
			memoryExceeded ||
			states[0].oomKilled ||
			(!states[0].running && states[0].exitCode === contestantExitCodes.MLE)
		)
			return {
				...result,
				passed: false,
				verdict: "MLE",
				score: 0,
				scoreRatio: 0,
				message: "选手程序实际内存使用超过限制。",
				memoryBytes,
			};
		// Docker attachment may close after the program's deadline. Use the trusted
		// launcher's container exit status, rather than contestant-writable metrics.
		if (!states[0].running && result.verdict !== "SYSTEM_ERROR") {
			const verdict =
				states[0].exitCode === contestantExitCodes.TLE
					? "TLE"
					: states[0].exitCode === contestantExitCodes.RE
						? "RE"
						: undefined;
			if (verdict)
				return {
					...result,
					passed: false,
					verdict,
					score: 0,
					scoreRatio: 0,
					message:
						verdict === "RE"
							? `选手程序异常退出：${participants[0].stderr}`.slice(0, 3000)
							: "选手程序运行超过时限。",
					memoryBytes,
					logPath: `logs/${contestant.role}-${test.id}.json`,
				};
		}
		return { ...result, memoryBytes, logPath: `logs/${contestant.role}-${test.id}.json` };
	} finally {
		try {
			await remove(names, input.stage);
		} finally {
			for (const participant of participants) {
				participant.process.kill("SIGKILL");
				participant.process.stdout.destroy();
				participant.process.stderr.destroy();
				participant.process.stdin.destroy();
			}
			await Promise.all(participants.map((participant) => participant.completion));
		}
		const logs = participants.map((item, index) => ({
			role: index ? "interactor" : contestant.role,
			stderr: item.stderr,
			bytes: item.bytes,
			stdout: Buffer.concat(item.output).toString("utf8"),
			truncated: item.bytes > captureLimit,
		}));
		await writeFile(join(input.stage, "logs", `${contestant.role}-${test.id}.json`), JSON.stringify(logs));
	}
}

export async function runInteractiveSandbox(
	input: SandboxInput,
	adapter?: InteractorAdapter,
): Promise<ManualSandboxReport> {
	if (input.compilationCache) input = { ...input, image: input.compilationCache.image };
	const taskId = input.context?.id ?? randomUUID();
	const report: ManualSandboxReport = {
		mode: input.mode,
		success: false,
		checks: [],
		caseCount: input.cases?.length ?? 0,
		generatedCount: 0,
		oracleCount: 0,
		validatorUsed: Boolean(input.validator),
		checkerUsed: false,
		interactorUsed: !input.communication,
		communicationUsed: Boolean(input.communication),
	};
	const check = (item: ManualCheck) => {
		const bounded = { ...item, message: item.message.slice(0, 3000) };
		report.checks.push(bounded);
		input.context?.emit("check", bounded.message, bounded);
	};
	await mkdir(join(input.stage, "logs"), { recursive: true });
	await mkdir(join(input.stage, "verified"), { recursive: true });
	await rm(join(input.stage, "launcher.py"), { force: true });
	await writeFile(join(input.stage, "launcher.py"), launcher);
	await chmod(join(input.stage, "launcher.py"), 0o444);
	const programs = new Map<Role, Program>();
	let diagnosticBytes = 0;
	const reserveDiagnostic = (bytes: number) => {
		diagnosticBytes += bytes;
		if (diagnosticBytes > 512 * 1024 * 1024) throw new Error("通信诊断文件超过任务容量上限。");
	};
	try {
		const sources: Array<readonly [Role, ManualProgram | undefined]> = [
			...(!input.contestants
				? [["reference", input.reference] as const, ["oracle", input.oracle] as const]
				: input.contestants.map((item, index) => [`candidate${index}` as Role, item.program] as const)),
			...[
				...(input.communication &&
				input.contestants &&
				!input.contestants.some((item) => item.id === input.primaryId)
					? [["reference", input.reference] as const]
					: []),
			],
			[
				"interactor",
				input.communication
					? {
							language: communicationCompileStandard(input.communication, input.checkerStandard),
							code:
								adapter?.source ??
								communicationAdapter(input.communication, input.checker ?? "", "local", input.maxFileBytes),
						}
					: input.interactor,
			],
			...sandboxGenerators(input).map((item, index) => [`generator${index}` as Role, item] as const),
			["validator", input.validator ? { language: input.validatorStandard, code: input.validator } : undefined],
		];
		for (const [role, source] of sources) {
			if (!source) continue;
			input.context?.signal.throwIfAborted();
			const adapted = role === "interactor" && adapter;
			const cacheKey = createHash("sha256")
				.update(JSON.stringify([source.language, source.code, adapted ? [adapted.build, adapted.run] : undefined]))
				.digest("hex");
			const cached = input.compilationCache?.programs.get(cacheKey);
			if (cached) {
				await writeFile(join(input.stage, "logs", `${role}.compile.txt`), cached.log);
				check({
					stage: `compile:${role}`,
					passed: cached.passed,
					verdict: cached.passed ? "AC" : "CE",
					message: cached.message,
					logPath: `logs/${role}.compile.txt`,
				});
				if (cached.passed)
					programs.set(role, {
						role,
						language: source.language,
						directory: cached.directory,
						command: adapted ? ["/bin/sh", "/program/run"] : programCommand(source.language, input.memoryLimitMb),
					});
				else if (!input.contestants || !role.startsWith("candidate")) return report;
				continue;
			}
			input.context?.emit("stage", `编译 ${role}`);
			const directory = join(input.stage, "programs", role);
			await mkdir(directory, { recursive: true });
			await chmod(directory, 0o777);
			const filename = adapted
				? "interactor.cc"
				: source.language.startsWith("cpp")
					? "main.cc"
					: source.language === "java"
						? "Main.java"
						: "main.py";
			await writeFile(join(directory, filename), source.code);
			await chmod(join(directory, filename), 0o644);
			if (adapted) {
				await writeFile(join(directory, "build"), adapted.build);
				await writeFile(join(directory, "run"), adapted.run);
				await copyFile(adapted.testlibPath, join(directory, "testlib.h"));
				for (const name of ["build", "run", "testlib.h"]) await chmod(join(directory, name), 0o644);
			}
			const name = `setdraft-task-${taskId}-${role}`;
			const compile = adapted ? ["/bin/sh", "/program/build"] : buildCommand(source.language);
			const created = await docker([
				"create",
				"--name",
				name,
				...sandboxRuntimeArgs(),
				"--ulimit",
				`fsize=${Math.max(input.maxFileBytes, 16 * 1024 * 1024)}`,
				"--mount",
				`type=bind,source=${directory},target=/program`,
				"--workdir",
				"/tmp",
				"--entrypoint",
				compile[0],
				input.image,
				...compile.slice(1),
			]);
			if (created.code !== 0) throw new Error(created.stderr);
			input.context?.signal.throwIfAborted();
			const result = await docker(["start", "--attach", name], 60_000, input.context?.signal);
			await remove([name], input.stage);
			await writeFile(join(input.stage, "logs", `${role}.compile.txt`), result.stdout + result.stderr);
			input.context?.signal.throwIfAborted();
			input.compilationCache?.programs.set(cacheKey, {
				directory,
				passed: result.code === 0,
				log: result.stdout + result.stderr,
				message: result.stderr || "编译成功。",
			});
			check({
				stage: `compile:${role}`,
				passed: result.code === 0,
				verdict: result.code === 0 ? "AC" : "CE",
				message: result.stderr || "编译成功。",
				logPath: `logs/${role}.compile.txt`,
			});
			if (result.code !== 0) {
				if (input.contestants && role.startsWith("candidate")) continue;
				return report;
			}
			programs.set(role, {
				role,
				language: source.language,
				directory,
				command: adapted ? ["/bin/sh", "/program/run"] : programCommand(source.language, input.memoryLimitMb),
			});
		}
		const jury = programs.get("interactor");
		if (!jury) throw new Error("缺少交互器。");
		const cases = [...(input.cases ?? [])];
		if (input.mode === "generate") {
			if (!input.commands?.length) throw new Error("缺少生成命令。");
			await mkdir(join(input.stage, "generated"), { recursive: true });
			for (const [index, command] of sandboxGeneratorCommands(input).entries()) {
				const generator = programs.get(
					`generator${sandboxGenerators(input).findIndex((item) => item.name === command.generator)}`,
				);
				if (!generator) throw new Error(`缺少生成器 ${command.generator}。`);
				const caseId = String((input.startNumber ?? 1) + index);
				const first = await runSingle(input, taskId, generator, command.args);
				const second = await runSingle(input, taskId, generator, command.args);
				const valid = first.code === 0 && second.code === 0 && first.stdout.equals(second.stdout);
				check({
					stage: "reproducibility",
					caseId,
					passed: valid,
					verdict: valid ? "AC" : "SYSTEM_ERROR",
					message: valid ? "固定参数重跑一致。" : first.stderr || second.stderr || "生成器重跑结果不一致。",
				});
				if (!valid) return report;
				const inputPath = join(input.stage, "generated", `${caseId}.in`);
				await writeFile(inputPath, first.stdout);
				cases.push({ id: caseId, inputPath, outputName: `${caseId}.out` });
			}
		}
		const communicate = async (contestant: Program, test: SandboxCase, generation = false): Promise<ManualCheck> => {
			try {
				const firstTest = { ...test, id: `${test.id}-round1`, outputPath: undefined };
				let first = await dialogue(input, taskId, contestant, jury, firstTest, Boolean(adapter), 1);
				const firstLog = `logs/${contestant.role}-${firstTest.id}.json`;
				reserveDiagnostic((await stat(join(input.stage, firstLog))).size);
				const nextPath = join(input.stage, "jury", `${contestant.role}-${firstTest.id}`, "nextpass.in");
				let second: ManualCheck | undefined;
				const paths: string[] = [];
				if (first.verdict === "AC" && first.score === 100) {
					try {
						const envelope = await readSandboxFile(
							input.stage,
							`jury/${contestant.role}-${firstTest.id}/nextpass.in`,
							input.maxFileBytes,
							input.context?.signal,
						);
						const decoded = readCommunicationEnvelope(envelope, input.maxFileBytes);
						const initial = await readFile(test.inputPath);
						if (
							!decoded.original.equals(
								adapter?.communicationInputEnvelope ? readCommunicationInitialInput(initial) : initial,
							)
						)
							throw new Error("通信交接改变了原始私有输入。");
						const handoffPath = `logs/${contestant.role}-${test.id}.handoff`;
						reserveDiagnostic(envelope.length);
						await writeFile(join(input.stage, handoffPath), envelope);
						paths.push(handoffPath);
					} catch (error) {
						first = {
							...first,
							passed: false,
							verdict: "SYSTEM_ERROR",
							score: 0,
							scoreRatio: 0,
							message: String(error),
						};
					}
					if (first.passed) {
						if (!generation && input.communication?.secondRound !== "interactive" && !test.outputPath)
							second = {
								stage: "interaction",
								passed: false,
								verdict: "SYSTEM_ERROR",
								message: "主标程未生成第二轮标准答案。",
							};
						else
							second = await dialogue(
								input,
								taskId,
								contestant,
								jury,
								{ ...test, id: `${test.id}-round2`, inputPath: nextPath },
								Boolean(adapter),
								2,
								generation,
							);
					}
				}
				const secondLog =
					second?.logPath ??
					(second?.durationMs !== undefined ? `logs/${contestant.role}-${test.id}-round2.json` : undefined);
				if (secondLog) paths.push(secondLog);
				if (secondLog) reserveDiagnostic((await stat(join(input.stage, secondLog))).size);
				if (second && input.communication?.secondRound !== "interactive") {
					const folder = `jury/${contestant.role}-${test.id}-round2`;
					const output = await readSandboxFile(
						input.stage,
						`${folder}/final.out`,
						input.maxFileBytes,
						input.context?.signal,
					).catch(() => undefined);
					if (output) {
						const outputPath = `logs/${contestant.role}-${test.id}.out`;
						reserveDiagnostic(output.length);
						await writeFile(join(input.stage, outputPath), output);
						paths.push(outputPath);
						if (generation && second.passed && second.score === 100)
							await writeFile(join(input.stage, "verified", test.outputName), output);
					}
				}
				if (second && test.outputPath) {
					const expected = `logs/${contestant.role}-${test.id}.expected`;
					reserveDiagnostic((await stat(test.outputPath)).size);
					await copyFile(test.outputPath, join(input.stage, expected));
					paths.push(expected);
				}
				const final = second ?? first;
				const failedRound: 1 | 2 | undefined =
					first.verdict !== "AC" || first.score !== 100
						? 1
						: second?.verdict !== "AC" || second.score !== 100
							? 2
							: undefined;
				const result: ManualCheck = {
					...final,
					stage: `interaction:${contestant.role}`,
					caseId: test.id,
					passed: first.passed && second?.passed === true,
					score: second?.score ?? 0,
					scoreRatio: second?.scoreRatio ?? 0,
					failedRound,
					durationMs: Math.max(first.durationMs ?? 0, second?.durationMs ?? 0),
					memoryBytes: Math.max(first.memoryBytes ?? 0, second?.memoryBytes ?? 0),
					logPath: `logs/${contestant.role}-${test.id}.json`,
					rounds: [
						{
							round: 1,
							state: "complete",
							verdict: first.verdict,
							score: 0,
							message: first.message,
							durationMs: first.durationMs,
							memoryBytes: first.memoryBytes,
							logPath: firstLog,
							artifacts: paths.filter((path) => path.endsWith(".handoff")),
						},
						second
							? {
									round: 2,
									state: "complete",
									verdict: second.verdict,
									score: second.score,
									message: second.message,
									durationMs: second.durationMs,
									memoryBytes: second.memoryBytes,
									logPath: secondLog,
									artifacts: paths.filter((path) => !path.endsWith(".handoff")),
								}
							: { round: 2, state: "skipped", message: "未运行：第一轮失败" },
					],
				};
				const summary = JSON.stringify(result.rounds);
				reserveDiagnostic(Buffer.byteLength(summary));
				await writeFile(join(input.stage, result.logPath!), summary);
				return result;
			} finally {
				// Persisted diagnostics use the bounded flat logs; temporary jury files are no longer needed.
				await Promise.all(
					([1, 2] as const).map((round) =>
						rm(join(input.stage, "jury", `${contestant.role}-${test.id}-round${round}`), {
							recursive: true,
							force: true,
						}),
					),
				);
			}
		};
		for (const test of cases) {
			input.context?.signal.throwIfAborted();
			const validator = programs.get("validator");
			if (validator) {
				const validation = await runSingle(input, taskId, validator, [], await readFile(test.inputPath));
				check({
					stage: "validator",
					caseId: test.id,
					passed: validation.code === 0,
					verdict: validation.code === 0 ? "AC" : "SYSTEM_ERROR",
					message: validation.stderr || "输入校验通过。",
				});
				if (validation.code !== 0) continue;
			}
			const candidateRoles = input.contestants
				? input.contestants.map((_, index): Role => `candidate${index}`)
				: (["reference", "oracle"] as const);
			let baseline: ManualCheck | undefined;
			const primaryRole: Role = input.contestants?.some((item) => item.id === input.primaryId)
				? `candidate${input.contestants.findIndex((item) => item.id === input.primaryId)}`
				: "reference";
			if (input.communication && input.communication.secondRound !== "interactive") {
				const primary = programs.get(primaryRole);
				if (primary) {
					baseline = await communicate(primary, test, !test.outputPath);
					check(baseline);
					if (baseline.passed && baseline.score === 100 && test.outputPath)
						await copyFile(test.outputPath, join(input.stage, "verified", test.outputName));
				}
			}
			for (const role of candidateRoles) {
				const contestant = programs.get(role);
				if (!contestant) continue;
				if (baseline && role === primaryRole) continue;
				const answerPath = join(input.stage, "verified", test.outputName);
				const answer = baseline?.passed && baseline.score === 100 ? answerPath : undefined;
				const result = input.communication
					? await communicate(contestant, { ...test, outputPath: answer })
					: await dialogue(input, taskId, contestant, jury, test, Boolean(adapter));
				check(result);
				if (role === "oracle") report.oracleCount += 1;
				input.context?.signal.throwIfAborted();
			}
			if (!input.communication || input.communication.secondRound === "interactive")
				await writeFile(join(input.stage, "verified", test.outputName), "");
			if (input.mode === "generate") {
				await copyFile(
					join(input.stage, "verified", test.outputName),
					join(input.stage, "generated", test.outputName),
				);
				report.generatedCount += 1;
			}
		}
		report.success = cases.length > 0 && report.checks.every((item) => item.passed);
	} catch (error) {
		if (error instanceof SandboxCleanupError) throw error;
		check({ stage: "interaction:system", passed: false, verdict: "SYSTEM_ERROR", message: String(error) });
	} finally {
		await remove(interactiveContainerNames(taskId), input.stage);
		await writeFile(join(input.stage, "result.json"), JSON.stringify(report));
	}
	input.context?.signal.throwIfAborted();
	return report;
}
