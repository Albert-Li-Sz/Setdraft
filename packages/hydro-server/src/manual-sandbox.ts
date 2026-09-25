import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const cppLanguages = ["cpp11", "cpp14", "cpp17", "cpp20", "cpp23", "cpp26"] as const;
export type CppLanguage = (typeof cppLanguages)[number];
export type ProgramLanguage = CppLanguage | "python3" | "java";
export interface ManualProgram {
	language: ProgramLanguage;
	code: string;
}

export interface ManualCheck {
	stage: string;
	caseId?: string;
	passed: boolean;
	message: string;
}

export interface ManualSandboxReport {
	mode: "generate" | "finalize";
	success: boolean;
	checks: ManualCheck[];
	caseCount: number;
	generatedCount: number;
	oracleCount: number;
	validatorUsed: boolean;
	checkerUsed: boolean;
}

export interface SandboxCase {
	id: string;
	inputPath: string;
	outputPath?: string;
	outputName: string;
}

export interface SandboxInput {
	mode: "generate" | "finalize";
	stage: string;
	image: string;
	reference: ManualProgram;
	oracle?: ManualProgram;
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

const runner = String.raw`
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

def check(stage, passed, message, case_id=None):
    checks.append({'stage': stage, 'caseId': case_id, 'passed': bool(passed), 'message': str(message)[:3000]})
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
            env={'PATH':'/usr/local/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'HOME':'/tmp'},
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
    return {'status':status, 'code':process.returncode, 'stderr':error_path.read_text(encoding='utf-8', errors='replace')[:3000],
            'durationMs':round((time.monotonic()-started)*1000), 'bytes':size}

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
    if not check('compile:' + role, result['status'] == 'ok', result['stderr'] or result['status']): return False
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
    check(role, result['status'] == 'ok', result['stderr'] or (result['status'] + ', ' + str(result['durationMs']) + ' ms'), case_id)
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

def checker_score(input_path, contestant, answer, label, case_id):
    directory = root / 'run' / 'checker' / case_id / label
    result = run(commands['checker'] + [str(input_path), str(contestant), str(answer)], None,
                 directory / 'stdout', 10, 512, directory)
    verdict = result['stderr']
    if result['status'] == 'ok' and result['code'] == 0 and verdict.startswith('ok'):
        match = re.search(r'\bscore\((\d+)\)', verdict)
        return int(match.group(1)) if match else 100
    if result['status'] == 'runtime_error' and result['code'] in (1, 2) and verdict.startswith(('wrong answer','wrong output format')):
        match = re.search(r'\bscore\((\d+)\)', verdict)
        return int(match.group(1)) if match else 0
    partial = re.match(r'^partially correct \((\d+)\)', verdict)
    points = re.match(r'^points ([\d.]+)', verdict)
    if result['status'] == 'runtime_error' and (partial or points):
        fraction = float((partial or points).group(1))
        if fraction > 1: fraction /= 100
        if 0 <= fraction <= 1: return int(fraction * 100)
    check('checker-system', False, verdict or result['status'], case_id)
    return None

def validate_input(input_path, case_id):
    if 'validator' not in commands: return True
    directory = root / 'run' / 'validator' / case_id
    result = run(commands['validator'], input_path, directory / 'stdout', 10, 512, directory)
    return check('validator', result['status'] == 'ok', result['stderr'] or result['status'], case_id)

def verify_case(case_id, input_path, supplied_output, output_name):
    if not validate_input(input_path, case_id): return
    standard = root / 'verified' / output_name
    if not program('reference', input_path, standard, case_id): return
    answer = supplied_output if supplied_output else standard
    if supplied_output:
        score = checker_score(input_path, standard, supplied_output, 'reference-vs-answer', case_id) if 'checker' in commands else (100 if same_default(standard, supplied_output) else 0)
        check('answer', score == 100, '标程与上传答案相容' if score == 100 else '标程与上传答案不一致', case_id)
        if score != 100: return
        shutil.copyfile(supplied_output, standard)
    if 'checker' in commands:
        score = checker_score(input_path, standard, standard, 'self', case_id)
        check('checker-self', score == 100, '满分' if score == 100 else '正确答案未得到满分', case_id)
        bad = root / 'run' / 'checker' / case_id / 'bad.txt'
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text('__hydro_invalid_output__\n', encoding='utf-8')
        negative = checker_score(input_path, bad, standard, 'negative-format', case_id)
        check('checker-negative:format', negative is not None and negative < 100,
              '格式错误输出已拒绝' if negative is not None and negative < 100 else '格式错误输出得到满分', case_id)
        tokens = standard.read_text(encoding='utf-8', errors='replace').split()
        if tokens and re.fullmatch(r'[+-]?\d+', tokens[0]):
            altered = [str(int(tokens[0]) + 1000000007)] + tokens[1:]
            bad.write_text(' '.join(altered) + '\n', encoding='utf-8')
        else:
            bad.write_text('1000000007\n', encoding='utf-8')
        negative = checker_score(input_path, bad, standard, 'negative-value', case_id)
        check('checker-negative:value', negative is not None and negative < 100,
              '错误数值输出已拒绝' if negative is not None and negative < 100 else '错误数值输出得到满分', case_id)
    if 'oracle' in commands:
        global oracle_count
        oracle_count += 1
        other = root / 'run' / 'oracle-output' / (case_id + '.out')
        if program('oracle', input_path, other, case_id):
            score = checker_score(input_path, other, standard, 'oracle', case_id) if 'checker' in commands else (100 if same_default(other, standard) else 0)
            check('oracle-compare', score == 100, '第二标准程序与答案相容' if score == 100 else '第二标准程序与答案不一致', case_id)

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
                check('sample', score == 100, '样例输出匹配' if score == 100 else '样例输出不匹配', str(index + 1))
        for case in payload['cases']:
            input_path = root / case['inputPath']
            supplied = root / case['outputPath'] if case.get('outputPath') else None
            verify_case(case['id'], input_path, supplied, case['outputName'])

try:
    main()
except Exception as error:
    check('sandbox', False, repr(error))
report = {'mode':payload['mode'], 'success':bool(checks) and all(item['passed'] for item in checks), 'checks':checks,
          'caseCount':len(payload.get('cases', [])), 'generatedCount':generated_count,
          'oracleCount':oracle_count, 'validatorUsed':'validator' in commands, 'checkerUsed':'checker' in commands}
(root / 'result.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'success':report['success'], 'checks':len(checks)}, ensure_ascii=False))
`;

function runDocker(args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		const errors: Buffer[] = [];
		const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stderr.on("data", (chunk: Buffer) => {
			if (errors.reduce((sum, item) => sum + item.byteLength, 0) < 64 * 1024) errors.push(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve();
			else reject(new Error(Buffer.concat(errors).toString("utf8").slice(0, 4000) || `Docker exited with ${code}.`));
		});
	});
}

export async function runManualSandbox(input: SandboxInput): Promise<ManualSandboxReport> {
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
	await runDocker(
		[
			"run",
			"--rm",
			"--network",
			"none",
			"--cpus",
			"1",
			"--memory",
			"2g",
			"--memory-swap",
			"2g",
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
			"/tmp:rw,exec,size=128m,mode=1777",
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
	);
	return JSON.parse(await readFile(join(input.stage, "result.json"), "utf8")) as ManualSandboxReport;
}
