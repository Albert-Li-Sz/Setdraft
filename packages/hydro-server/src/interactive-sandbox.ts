import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManualCheck, ManualProgram, ManualSandboxReport } from "@setdraft/contracts";
import type { SandboxCase, SandboxInput } from "./manual-sandbox.ts";
import { sandboxPolicy } from "./sandbox-policy.ts";
import { sandboxRuntimeArgs } from "./sandbox-runtime.ts";

const roles = ["reference", "oracle", "interactor", "validator", "generator"] as const;
type Role = (typeof roles)[number];
const captureLimit = 64 * 1024;
const readyMarker = "SETDRAFT_INTERACTIVE_READY\n";
const launcher = String.raw`import math, os, resource, sys
timeout, memory, file_limit = map(int, sys.argv[1:4])
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(timeout / 1000) + 1, math.ceil(timeout / 1000) + 1))
if memory:
    resource.setrlimit(resource.RLIMIT_AS, (memory * 1048576, memory * 1048576))
os.chdir('/tmp')
os.write(2, b'SETDRAFT_INTERACTIVE_READY\n')
if os.read(0, 1) != b'\n': sys.exit(125)
os.execvpe(sys.argv[4], sys.argv[4:], {'PATH':'/usr/local/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'LC_ALL':'C.UTF-8', 'TZ':'UTC', 'HOME':'/tmp'})
`;

export function interactiveContainerNames(taskId: string): string[] {
	return roles.map((role) => `setdraft-task-${taskId}-${role}`);
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

async function remove(names: string[]): Promise<void> {
	if (!names.length) return;
	const result = await docker(["rm", "-f", ...names]);
	if (result.code !== 0 && result.stderr.split("\n").some((line) => line && !line.includes("No such container")))
		throw new Error(`交互容器清理失败：${result.stderr}`);
}

interface Program {
	role: Role;
	directory: string;
	language: ManualProgram["language"];
	command: string[];
}

export interface InteractorAdapter {
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
		await remove([name]);
	}
}

async function dialogue(
	input: SandboxInput,
	taskId: string,
	contestant: Program,
	jury: Program,
	test: SandboxCase,
	adapted: boolean,
): Promise<ManualCheck> {
	const policy = sandboxPolicy();
	const juryMemory = 512;
	const contestantMemory = input.memoryLimitMb + (contestant.language === "java" ? 256 : 64);
	if (juryMemory + contestantMemory > policy.memoryMb)
		throw new Error(`交互任务需要至少 ${juryMemory + contestantMemory} MiB 沙箱内存预算。`);
	const directory = join(input.stage, "jury", `${contestant.role}-${test.id}`);
	await mkdir(directory, { recursive: true });
	await chmod(directory, 0o777);
	await copyFile(test.inputPath, join(directory, "input.in"));
	await writeFile(join(directory, "answer.ans"), "");
	await chmod(join(directory, "input.in"), 0o444);
	await chmod(join(directory, "answer.ans"), 0o444);
	const names = [contestant, jury].map((program) => `setdraft-task-${taskId}-${program.role}`);
	const participants: Participant[] = [];
	try {
		for (const [index, program] of [contestant, jury].entries()) {
			input.context?.signal.throwIfAborted();
			const isJury = index === 1;
			const memory = isJury ? juryMemory : contestantMemory;
			const command = [
				...program.command,
				...(isJury
					? adapted
						? ["/jury/input.in", "/jury/answer.ans", "/jury"]
						: ["/jury/input.in", "/jury/transcript", "/jury/answer.ans"]
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
				"--workdir",
				"/tmp",
				"--entrypoint",
				"python3",
				input.image,
				"/launcher.py",
				String(input.timeLimitMs),
				String(isJury ? juryMemory : contestant.language === "java" ? 0 : input.memoryLimitMb),
				String(input.maxFileBytes),
				...command,
			]);
			if (result.code !== 0) throw new Error(result.stderr || "无法创建交互容器。");
		}
		input.context?.signal.throwIfAborted();
		const result = await new Promise<ManualCheck>((resolve) => {
			let started = 0;
			let settled = false;
			let timer: NodeJS.Timeout;
			const finish = (verdict: ManualCheck["verdict"], message: string, score?: number) => {
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
					const explicit = /\bscore\((-?\d+)\)/u.exec(message);
					const points = /^points ([\d.]+)/u.exec(message);
					const partial = /^partially correct \(([\d.]+)\)/u.exec(message);
					const fraction = Number((points ?? partial)?.[1]);
					const score = explicit
						? Number(explicit[1])
						: points || partial
							? Math.floor(fraction * (fraction > 1 ? 1 : 100))
							: 100;
					if (!Number.isFinite(score) || score < 0 || score > 100) {
						finish("SYSTEM_ERROR", "交互器返回无效分数。");
						return;
					}
					if ((adapted ? [42, 43] : [0]).includes(interactor.code ?? -1) && /^ok\b/u.test(message)) {
						if (team.closed)
							finish(
								team.code === 0 ? (score === 100 ? "AC" : "WA") : "RE",
								team.code === 0 ? message : `选手程序异常退出：${team.stderr}`,
								team.code === 0 ? score : 0,
							);
					} else if (
						adapted
							? [42, 43].includes(interactor.code ?? -1) && (points || partial)
							: (points && interactor.code === 7) || (partial && interactor.code === Number(partial[1]))
					) {
						if (score !== 100 || team.closed)
							finish(team.closed && team.code !== 0 ? "RE" : score === 100 ? "AC" : "WA", message, score);
					} else if (
						(adapted ? [43] : [1, 2]).includes(interactor.code ?? -1) &&
						/^(wrong answer|wrong output format)\b/u.test(message)
					) {
						finish(team.closed && team.code !== 0 ? "RE" : "WA", message, 0);
					} else finish("SYSTEM_ERROR", `交互器错误（${interactor.code}）：${message}`);
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
									team.closed && team.code !== 0 ? "RE" : "TLE",
									team.closed && team.code !== 0
										? `选手程序异常退出：${team.stderr}`
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
		return result;
	} finally {
		await remove(names);
		for (const participant of participants) {
			participant.process.kill("SIGKILL");
			participant.process.stdout.destroy();
			participant.process.stderr.destroy();
			participant.process.stdin.destroy();
		}
		await Promise.all(participants.map((participant) => participant.completion));
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
		interactorUsed: true,
	};
	const check = (item: ManualCheck) => {
		const bounded = { ...item, message: item.message.slice(0, 3000) };
		report.checks.push(bounded);
		input.context?.emit("check", bounded.message, bounded);
	};
	await mkdir(join(input.stage, "logs"), { recursive: true });
	await mkdir(join(input.stage, "verified"), { recursive: true });
	await writeFile(join(input.stage, "launcher.py"), launcher);
	await chmod(join(input.stage, "launcher.py"), 0o444);
	const programs = new Map<Role, Program>();
	try {
		for (const [role, source] of [
			["reference", input.reference],
			["interactor", input.interactor],
			["oracle", input.oracle],
			["generator", input.generator ? { language: input.generatorStandard, code: input.generator } : undefined],
			["validator", input.validator ? { language: input.validatorStandard, code: input.validator } : undefined],
		] as const) {
			if (!source) continue;
			input.context?.signal.throwIfAborted();
			input.context?.emit("stage", `编译 ${role}`);
			const directory = join(input.stage, "programs", role);
			await mkdir(directory, { recursive: true });
			await chmod(directory, 0o777);
			const adapted = role === "interactor" && adapter;
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
			await remove([name]);
			input.context?.signal.throwIfAborted();
			check({
				stage: `compile:${role}`,
				passed: result.code === 0,
				verdict: result.code === 0 ? "AC" : "CE",
				message: result.stderr || "编译成功。",
			});
			if (result.code !== 0) return report;
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
			const generator = programs.get("generator");
			if (!generator || !input.commands?.length) throw new Error("缺少生成器或生成命令。");
			await mkdir(join(input.stage, "generated"), { recursive: true });
			for (const [index, args] of input.commands.entries()) {
				const caseId = String((input.startNumber ?? 1) + index);
				const first = await runSingle(input, taskId, generator, args);
				const second = await runSingle(input, taskId, generator, args);
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
			for (const role of ["reference", "oracle"] as const) {
				const contestant = programs.get(role);
				if (!contestant) continue;
				const result = await dialogue(input, taskId, contestant, jury, test, Boolean(adapter));
				check(result);
				if (role === "oracle") report.oracleCount += 1;
				input.context?.signal.throwIfAborted();
			}
			await writeFile(join(input.stage, "verified", test.outputName), "");
			if (input.mode === "generate") {
				await writeFile(join(input.stage, "generated", test.outputName), "");
				report.generatedCount += 1;
			}
		}
		report.success = cases.length > 0 && report.checks.every((item) => item.passed);
	} catch (error) {
		check({ stage: "interaction:system", passed: false, verdict: "SYSTEM_ERROR", message: String(error) });
	} finally {
		await remove(interactiveContainerNames(taskId));
		await writeFile(join(input.stage, "result.json"), JSON.stringify(report));
	}
	input.context?.signal.throwIfAborted();
	return report;
}
