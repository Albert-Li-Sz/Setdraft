import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CppLanguage, ManualProgram, ManualSandboxReport } from "@setdraft/contracts";
import { pythonCheckerProtocol } from "./checker-protocol.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { interactiveContainerNames, runInteractiveSandbox } from "./interactive-sandbox.ts";
import { NOOP_OBSERVABILITY } from "./observability.ts";
import { readSandboxFile } from "./sandbox-files.ts";
import { readSandboxCheck, readSandboxReport } from "./sandbox-report.ts";
import { removeDockerContainer, SandboxCleanupError, sandboxRuntimeArgs } from "./sandbox-runtime.ts";

export interface SandboxCase {
	id: string;
	inputPath: string;
	outputPath?: string;
	outputName: string;
}

export interface SandboxInput {
	context?: ExecutionContext;
	mode: "generate" | "finalize";
	stage: string;
	image: string;
	reference: ManualProgram;
	interactor?: { language: CppLanguage; code: string };
	oracle?: ManualProgram;
	contestants?: Array<{ id: string; program: ManualProgram }>;
	generator?: string;
	generatorStandard: CppLanguage;
	commands?: string[][];
	startNumber?: number;
	checker?: string;
	checkerStandard: CppLanguage;
	validator?: string;
	validatorStandard: CppLanguage;
	timeLimitMs: number;
	memoryLimitMb: number;
	maxFileBytes: number;
	cases?: SandboxCase[];
	samples?: Array<{ input: string; output: string }>;
}

export const sandboxProgramRuntime = String.raw`
import hashlib, json, math, os, pathlib, re, resource, shutil, signal, subprocess, sys, time

root = pathlib.Path('/work')
payload = json.loads((root / 'payload.json').read_text(encoding='utf-8'))
checks = []
generated_count = 0
oracle_count = 0
commands = {}
languages = {}
file_limit = payload['maxFileBytes']
cpp_standards = {'cpp11':'c++11', 'cpp14':'c++14', 'cpp17':'c++17',
                 'cpp20':'c++20', 'cpp23':'c++23', 'cpp26':'c++26'}

def check(stage, passed, message, case_id=None, verdict=None, score=None, duration_ms=None, log_path=None):
    item = {'stage': stage, 'caseId': case_id, 'passed': bool(passed), 'message': str(message)[:3000]}
    if verdict is not None: item['verdict'] = verdict
    if score is not None: item['score'] = score
    if duration_ms is not None: item['durationMs'] = duration_ms
    if log_path is not None: item['logPath'] = log_path
    checks.append(item)
    print('SETDRAFT_CHECK ' + json.dumps(item, ensure_ascii=False), flush=True)
    return passed

def run(command, input_path, output_path, timeout, memory_mb, cwd):
    cwd.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    error_path = root / 'logs' / (output_path.relative_to(root).as_posix().replace('/', '_') + '.stderr')
    error_path.parent.mkdir(parents=True, exist_ok=True)
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(timeout) + 1, math.ceil(timeout) + 1))
        if memory_mb is not None:
            cap = memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
    started = time.monotonic()
    with open(input_path, 'rb') if input_path else open(os.devnull, 'rb') as stdin, \
         open(output_path, 'wb') as stdout, open(error_path, 'wb') as stderr:
        process = subprocess.Popen(command, stdin=stdin, stdout=stdout, stderr=stderr, cwd=cwd,
            env={'PATH':'/usr/local/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'LC_ALL':'C.UTF-8', 'TZ':'UTC', 'HOME':'/tmp'},
            start_new_session=True, preexec_fn=limits)
        status = 'ok'
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            status = 'time_limit'
        finally:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait()
    size = output_path.stat().st_size
    if status == 'ok' and size >= file_limit: status = 'output_limit'
    elif status == 'ok' and process.returncode != 0: status = 'runtime_error'
    return {'status':status, 'code':process.returncode, 'stderr':error_path.open('rb').read(12000).decode('utf-8', errors='replace')[:3000],
            'durationMs':round((time.monotonic()-started)*1000), 'bytes':size,
            'logPath':str(error_path.relative_to(root)), 'stderrBytes':error_path.stat().st_size}

def source(role, language, code):
    folder = root / 'build' / role
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / ('main.cc' if language in cpp_standards else {'python3':'main.py', 'java':'Main.java'}[language])
    path.write_text(code, encoding='utf-8')
    binary = folder / 'main'
    compile_cmd = (['g++','-std=' + cpp_standards[language],'-O2','-pipe','-I/opt/testlib',str(path),'-o',str(binary)]
                   if language in cpp_standards else
                   {'python3':['python3','-m','py_compile',str(path)],
                    'java':['javac','-J-Xmx256m',str(path)]}[language])
    result = run(compile_cmd, None, root / 'logs' / (role + '.compile'), 45, None, folder)
    if not check('compile:' + role, result['status'] == 'ok', result['stderr'] or result['status'],
                 verdict='AC' if result['status'] == 'ok' else 'CE', duration_ms=result['durationMs'], log_path=result['logPath']): return False
    commands[role] = ([str(binary)] if language in cpp_standards else
                      {'python3':['python3','-I',str(path)],
                       'java':['java','-XX:ActiveProcessorCount=1','-XX:+UseSerialGC','-cp',str(folder),'Main']}[language])
    languages[role] = language
    return True

def program(role, input_path, output_path, case_id):
    timeout = payload['timeLimitMs'] / 1000
    memory = payload['memoryLimitMb']
    cmd = commands[role][:]
    if languages[role] == 'java': cmd.insert(1, '-Xmx' + str(memory) + 'm')
    result = run(cmd, input_path, output_path, timeout, None if languages[role] == 'java' else memory,
                 root / 'run' / role / case_id)
    verdict = {'ok':'AC', 'time_limit':'TLE', 'runtime_error':'RE', 'output_limit':'RE'}.get(result['status'], 'SYSTEM_ERROR')
    check(role, result['status'] == 'ok', result['stderr'] or (result['status'] + ', ' + str(result['durationMs']) + ' ms'), case_id,
          verdict=verdict, duration_ms=result['durationMs'], log_path=result['logPath'])
    return result['status'] == 'ok'

def same_file(left, right):
    def digest(path):
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for block in iter(lambda: f.read(65536), b''): h.update(block)
        return h.digest()
    return digest(left) == digest(right)

def same_default(left, right):
    def normalized(path):
        text = path.read_text(encoding='utf-8', errors='replace').replace('\r\n','\n').replace('\r','\n')
        lines = [line.rstrip(' \t') for line in text.split('\n')]
        while lines and lines[-1] == '': lines.pop()
        return lines
    return normalized(left) == normalized(right)

${pythonCheckerProtocol}

def checker_score(input_path, contestant, answer, label, case_id, precise=False):
    directory = root / 'run' / 'checker' / case_id / label
    result = run(commands['checker'] + [str(input_path), str(contestant), str(answer)], None,
                 directory / 'stdout', 10, 512, directory)
    # Display truncation must never change the machine-readable verdict.
    if result['stderrBytes'] > 65536:
        check('checker-system', False, 'Checker diagnostic exceeds protocol limit', case_id, verdict='SYSTEM_ERROR', log_path=result['logPath'])
        return None
    verdict = (root / result['logPath']).read_text(encoding='utf-8', errors='replace')
    score = normalized_checker_score(result['code'], verdict) if result['status'] in ('ok', 'runtime_error') else None
    if score is not None: return normalized_checker_ratio(result['code'], verdict) if precise else score
    check('checker-system', False, verdict or result['status'], case_id, verdict='SYSTEM_ERROR',
          duration_ms=result['durationMs'], log_path=result['logPath'])
    return None

def validate_input(input_path, case_id):
    if 'validator' not in commands: return True
    directory = root / 'run' / 'validator' / case_id
    result = run(commands['validator'], input_path, directory / 'stdout', 10, 512, directory)
    return check('validator', result['status'] == 'ok', result['stderr'] or result['status'], case_id,
                 verdict='AC' if result['status'] == 'ok' else 'WA', duration_ms=result['durationMs'], log_path=result['logPath'])

`;

const runner = String.raw`${sandboxProgramRuntime}

def verify_case(case_id, input_path, supplied_output, output_name):
    if not validate_input(input_path, case_id): return
    standard = root / 'verified' / output_name
    if not program('reference', input_path, standard, case_id): return
    answer = supplied_output if supplied_output else standard
    if supplied_output:
        score = checker_score(input_path, standard, supplied_output, 'reference-vs-answer', case_id) if 'checker' in commands else (100 if same_default(standard, supplied_output) else 0)
        check('answer', score == 100, '标程与上传答案相容' if score == 100 else '标程与上传答案不一致', case_id,
              verdict='AC' if score == 100 else ('SYSTEM_ERROR' if score is None else 'WA'), score=score)
        if score != 100: return
        shutil.copyfile(supplied_output, standard)
    if 'checker' in commands:
        score = checker_score(input_path, standard, standard, 'self', case_id)
        check('checker-self', score == 100, '满分' if score == 100 else '正确答案未得到满分', case_id,
              verdict='AC' if score == 100 else ('SYSTEM_ERROR' if score is None else 'WA'), score=score)
        bad = root / 'run' / 'checker' / case_id / 'bad.txt'
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text('__hydro_invalid_output__\n', encoding='utf-8')
        negative = checker_score(input_path, bad, standard, 'negative-format', case_id)
        check('checker-probe:format', negative is not None,
              '自动格式探针判分有效；是否为错误答案须按题意确认' if negative is not None else '自动格式探针返回无效判分', case_id, score=negative)
        tokens = standard.read_text(encoding='utf-8', errors='replace').split()
        if tokens and re.fullmatch(r'[+-]?\d+', tokens[0]):
            altered = [str(int(tokens[0]) + 1000000007)] + tokens[1:]
            bad.write_text(' '.join(altered) + '\n', encoding='utf-8')
        else:
            bad.write_text('1000000007\n', encoding='utf-8')
        negative = checker_score(input_path, bad, standard, 'negative-value', case_id)
        check('checker-probe:value', negative is not None,
              '自动数值探针判分有效；是否为错误答案须按题意确认' if negative is not None else '自动数值探针返回无效判分', case_id, score=negative)
    if 'oracle' in commands:
        global oracle_count
        oracle_count += 1
        other = root / 'run' / 'oracle-output' / (case_id + '.out')
        if program('oracle', input_path, other, case_id):
            score = checker_score(input_path, other, standard, 'oracle', case_id) if 'checker' in commands else (100 if same_default(other, standard) else 0)
            check('oracle-compare', score == 100, '第二标准程序与答案相容' if score == 100 else '第二标准程序与答案不一致', case_id,
                  verdict='AC' if score == 100 else ('SYSTEM_ERROR' if score is None else 'WA'), score=score)

def main():
    programs = {'reference':payload['reference']}
    for role in ('oracle','generator','checker','validator'):
        if payload.get(role): programs[role] = payload[role]
    for role, item in programs.items():
        if not source(role, item['language'], item['code']): return
    if payload['mode'] == 'generate':
        global generated_count
        (root / 'generated').mkdir(exist_ok=True)
        for index, args in enumerate(payload['commands']):
            number = payload['startNumber'] + index
            case_id = str(number)
            first = root / 'generated' / (case_id + '.in')
            second = root / 'run' / 'repeat' / (case_id + '.in')
            command = commands['generator'] + args
            left = run(command, None, first, 30, 512, root / 'run' / 'generate' / case_id)
            right = run(command, None, second, 30, 512, root / 'run' / 'regenerate' / case_id)
            if not check('generator', left['status'] == 'ok' and right['status'] == 'ok',
                         left['stderr'] or right['stderr'] or left['status'], case_id): return
            if not check('reproducibility', same_file(first, second), '固定参数重跑一致', case_id): return
            verify_case(case_id, first, None, case_id + '.out')
            if any(not item['passed'] for item in checks): return
            shutil.copyfile(root / 'verified' / (case_id + '.out'), root / 'generated' / (case_id + '.out'))
            generated_count += 1
    else:
        for index, sample in enumerate(payload.get('samples', [])):
            directory = root / 'samples' / str(index)
            directory.mkdir(parents=True, exist_ok=True)
            input_path, expected = directory / 'input', directory / 'expected'
            input_path.write_text(sample['input'], encoding='utf-8')
            expected.write_text(sample['output'], encoding='utf-8')
            actual = directory / 'actual'
            if program('reference', input_path, actual, 'sample-' + str(index + 1)):
                score = checker_score(input_path, actual, expected, 'sample', 'sample-' + str(index + 1)) if 'checker' in commands else (100 if same_default(actual, expected) else 0)
                check('sample', score == 100, '样例输出匹配' if score == 100 else '样例输出不匹配', str(index + 1),
                      verdict='AC' if score == 100 else ('SYSTEM_ERROR' if score is None else 'WA'), score=score)
        for case in payload['cases']:
            input_path = root / case['inputPath']
            supplied = root / case['outputPath'] if case.get('outputPath') else None
            verify_case(case['id'], input_path, supplied, case['outputName'])

try:
    main()
except Exception as error:
    check('sandbox', False, repr(error), verdict='SYSTEM_ERROR')
toolchain = {'cpp':'GCC ' + subprocess.check_output(['g++','-dumpfullversion'], text=True).strip(),
             'python':subprocess.check_output(['python3','--version'], text=True).strip(),
             'java':subprocess.check_output(['javac','-version'], text=True, stderr=subprocess.STDOUT).strip()}
report = {'mode':payload['mode'], 'success':bool(checks) and all(item['passed'] for item in checks), 'checks':checks,
          'caseCount':len(payload.get('cases', [])), 'generatedCount':generated_count,
          'oracleCount':oracle_count, 'validatorUsed':'validator' in commands, 'checkerUsed':'checker' in commands,
          'toolchain':toolchain}
(root / 'result.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'success':report['success'], 'checks':len(checks)}, ensure_ascii=False))
`;

export type {
	CppLanguage,
	ManualCheck,
	ManualProgram,
	ManualSandboxReport,
	ProgramLanguage,
} from "@setdraft/contracts";
export { cppLanguages } from "@setdraft/contracts";

export async function removeTaskContainer(taskId: string): Promise<void> {
	const results = await Promise.allSettled(
		[`setdraft-task-${taskId}`, ...interactiveContainerNames(taskId)].map(removeDockerContainer),
	);
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}

export function runDocker(
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	taskId?: string,
	context?: ExecutionContext,
	stage?: string,
	onMatrixCell?: (value: unknown) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		const errors: Buffer[] = [];
		let stopping: Promise<void> | undefined;
		const stopContainer = () => {
			if (stopping) return;
			stopping = taskId ? removeTaskContainer(taskId) : Promise.resolve();
			void stopping.catch(() => {});
			child.kill("SIGKILL");
		};
		const timeout = setTimeout(stopContainer, timeoutMs);
		signal?.addEventListener("abort", stopContainer, { once: true });
		const decoder = new StringDecoder("utf8");
		let pending = "";
		let outputBytes = 0;
		let eventCount = 0;
		let errorBytes = 0;
		let failure: Error | undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > 8 * 1024 * 1024 || failure) {
				failure ??= new Error("沙箱进度输出超过容量上限。");
				stopContainer();
				return;
			}
			pending += decoder.write(chunk);
			try {
				let end = pending.indexOf("\n");
				while (end >= 0) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (line.startsWith("SETDRAFT_CHECK ")) {
						if (++eventCount > 50_000) throw new Error("沙箱进度条目过多。");
						const item = readSandboxCheck(JSON.parse(line.slice(15)));
						context?.emit("check", item.message, item);
					}
					if (line.startsWith("SETDRAFT_CELL ")) {
						if (++eventCount > 50_000) throw new Error("沙箱进度条目过多。");
						onMatrixCell?.(JSON.parse(line.slice(14)));
					}
					end = pending.indexOf("\n");
				}
				if (pending.length > 32 * 1024) throw new Error("沙箱进度行过长。");
			} catch (error) {
				failure = error instanceof Error ? error : new Error("沙箱进度无效。");
				stopContainer();
			}
		});
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", stopContainer);
		};
		child.stderr.on("data", (chunk: Buffer) => {
			errorBytes += chunk.length;
			if (errorBytes > 1024 * 1024) {
				failure ??= new Error("沙箱错误输出超过容量上限。");
				stopContainer();
				return;
			}
			if (errors.reduce((sum, item) => sum + item.byteLength, 0) < 64 * 1024) errors.push(chunk);
			context?.emit("log", chunk.toString("utf8"));
		});
		child.once("error", (error) => {
			failure ??= error;
		});
		child.once("close", async (code) => {
			cleanup();
			// Do not return the scheduler slot while Docker is still removing a cancelled container.
			try {
				if (taskId && (stopping || code !== 0 || failure)) {
					await stopping?.catch(() => undefined);
					await removeTaskContainer(taskId);
				}
			} catch {
				reject(
					new SandboxCleanupError(
						taskId ? [`setdraft-task-${taskId}`, ...interactiveContainerNames(taskId)] : [],
						stage ? [stage] : [],
					),
				);
				return;
			}
			if (code === 0 && !stopping && !failure) resolve();
			else
				reject(
					failure ??
						new Error(Buffer.concat(errors).toString("utf8").slice(0, 4000) || `Docker exited with ${code}.`),
				);
		});
		if (signal?.aborted) stopContainer();
	});
}

export async function runManualSandbox(input: SandboxInput): Promise<ManualSandboxReport> {
	const observability = input.context?.observability ?? NOOP_OBSERVABILITY;
	return observability.startSpan(
		{
			name: input.mode === "generate" ? "sandbox.generate" : "sandbox.validate",
			attributes: { "task.id": input.context?.id },
		},
		async (span) => {
			const report = await runManualSandboxImpl(input);
			span.setAttributes({ "operation.result": report.success ? "ok" : "failed" });
			if (!report.success) span.setStatus({ status: "error" });
			return report;
		},
	);
}

async function runManualSandboxImpl(input: SandboxInput): Promise<ManualSandboxReport> {
	if (input.interactor) return runInteractiveSandbox(input);
	const context = input.context;
	const taskId = context?.id ?? randomUUID();
	context?.signal.throwIfAborted();
	context?.emit("stage", input.mode === "generate" ? "编译并生成测试数据" : "执行完整验证");
	await mkdir(input.stage, { recursive: true });
	await chmod(input.stage, 0o777);
	await writeFile(join(input.stage, "runner.py"), runner);
	await mkdir(join(input.stage, "cases"), { recursive: true });
	for (const item of input.cases ?? []) {
		await copyFile(item.inputPath, join(input.stage, "cases", `${item.id}.in`));
		if (item.outputPath) await copyFile(item.outputPath, join(input.stage, "cases", `${item.id}.answer`));
	}
	const cases = input.cases?.map((item) => ({
		id: item.id,
		inputPath: `cases/${item.id}.in`,
		outputPath: item.outputPath ? `cases/${item.id}.answer` : undefined,
		outputName: item.outputName,
	}));
	const payload = {
		mode: input.mode,
		reference: input.reference,
		oracle: input.oracle,
		generator: input.generator ? { language: input.generatorStandard, code: input.generator } : undefined,
		checker: input.checker ? { language: input.checkerStandard, code: input.checker } : undefined,
		validator: input.validator ? { language: input.validatorStandard, code: input.validator } : undefined,
		commands: input.commands,
		startNumber: input.startNumber,
		timeLimitMs: input.timeLimitMs,
		memoryLimitMb: input.memoryLimitMb,
		maxFileBytes: input.maxFileBytes,
		cases,
		samples: input.samples,
	};
	await writeFile(join(input.stage, "payload.json"), JSON.stringify(payload));
	const totalCases = input.mode === "generate" ? (input.commands?.length ?? 0) : (input.cases?.length ?? 0);
	const timeoutMs = Math.max(120_000, 180_000 + totalCases * (input.timeLimitMs * 3 + 65_000));
	context?.signal.throwIfAborted();
	await runDocker(
		[
			"run",
			"--rm",
			"--name",
			`setdraft-task-${taskId}`,
			...sandboxRuntimeArgs(),
			"--mount",
			`type=bind,source=${input.stage},target=/work`,
			"--workdir",
			"/work",
			"--entrypoint",
			"python3",
			input.image,
			"/work/runner.py",
		],
		timeoutMs,
		context?.signal,
		taskId,
		context,
		input.stage,
	);
	const report = readSandboxReport(
		JSON.parse(
			(await readSandboxFile(input.stage, "result.json", 8 * 1024 * 1024, context?.signal)).toString("utf8"),
		),
	);
	if (
		report.mode !== input.mode ||
		(report.success &&
			(report.caseCount !== (input.cases?.length ?? 0) ||
				report.generatedCount !== (input.mode === "generate" ? totalCases : 0)))
	)
		throw new Error("沙箱报告与任务不一致。");
	return report;
}
