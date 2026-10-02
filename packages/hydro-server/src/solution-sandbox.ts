import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManualCheck, MatrixCell, Solution, StressOptions, StressReport } from "@setdraft/contracts";
import { runInteractiveSandbox } from "./interactive-sandbox.ts";
import { runDocker, type SandboxInput, sandboxProgramRuntime } from "./manual-sandbox.ts";
import { readSandboxFile } from "./sandbox-files.ts";
import { sandboxPolicy } from "./sandbox-policy.ts";
import { readSandboxCheck } from "./sandbox-report.ts";
import { sandboxRuntimeArgs } from "./sandbox-runtime.ts";

export interface SolutionSandboxInput extends SandboxInput {
	sandboxArgs?: string[];
	solutions: Solution[];
	primaryId: string;
	stress?: StressOptions & { args: string[] };
	replay?: { inputPath: string; seed: number; args: string[] };
	onProgress?: (update: { cell?: MatrixCell; check?: ManualCheck }) => void;
}
export interface SolutionSandboxResult {
	cells: MatrixCell[];
	checks: ManualCheck[];
	stress?: StressReport;
}

const runner = `${sandboxProgramRuntime}
cells = []
stress = None
class BudgetEnd(Exception): pass
deadline = time.monotonic() + payload['stress']['budgetMs'] / 1000 if payload.get('stress') else None
original_run = run
total_bytes = 0
def run(command, input_path, output_path, timeout, memory_mb, cwd):
    global total_bytes
    if deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise BudgetEnd()
        timeout = min(timeout, remaining)
    result = original_run(command, input_path, output_path, timeout, memory_mb, cwd)
    total_bytes += result['bytes'] + result['stderrBytes']
    if total_bytes > payload['maxTotalBytes']: raise RuntimeError('任务输出超过容量上限')
    if deadline and time.monotonic() >= deadline: raise BudgetEnd()
    return result

def preview(path):
    return path.open('rb').read(2048).decode('utf-8', errors='replace') if path.exists() else ''

def publish_cell(value):
    if not payload.get('stress'):
        print('SETDRAFT_CELL ' + json.dumps({k:v for k,v in value.items() if k not in ('output','expected','log')}, ensure_ascii=False), flush=True)
    return value

def cell(item, role, case, input_path, answer):
    output = root / 'outputs' / (role + '-' + case['id'] + '.out')
    result = {'solutionId':item['id'], 'caseId':case['key'], 'verdict':'CE', 'score':0, 'durationMs':0, 'message':'编译失败'}
    compile_role = 'reference' if item['id'] == payload['primaryId'] else role
    paths = {'logs':['logs/logs_' + compile_role + '.compile.stderr']}
    result['artifacts'] = paths
    if role not in commands:
        compile_check = next((check for check in checks if check['stage'] == 'compile:' + role), None)
        result['log'] = compile_check['message'] if compile_check else '编译失败'
        return result
    if not program(role, input_path, output, case['id']):
        actual = checks[-1]
        paths.update(output=str(output.relative_to(root)))
        if answer is not None: paths['expected'] = str(answer.relative_to(root))
        if actual.get('logPath'): paths['logs'].append(actual['logPath'])
        result.update(verdict=actual['verdict'], durationMs=actual['durationMs'], message=actual['message'], log=preview(root / actual['logPath']) if actual.get('logPath') else '')
        result.update(output=preview(output), expected=preview(answer) if answer is not None else '')
        return result
    duration = checks[-1]['durationMs']
    paths.update(output=str(output.relative_to(root)))
    if checks[-1].get('logPath'): paths['logs'].append(checks[-1]['logPath'])
    if answer is None:
        result.update(verdict='SYSTEM_ERROR', durationMs=duration, message='程序已运行，但主标程未完成，无法判分', output=preview(output))
        return result
    ratio = checker_score(input_path, output, answer, role, case['id'], precise=True) if 'checker' in commands else (1 if same_default(output, answer) else 0)
    paths['expected'] = str(answer.relative_to(root))
    score = None if ratio is None else (100 if ratio == 1 else min(99, math.floor(ratio * 100)))
    result.update(verdict='SYSTEM_ERROR' if score is None else ('AC' if score == 100 else 'WA'), score=score or 0,
                  scoreRatio=ratio or 0, durationMs=duration, message='Checker 判定' if score is not None else 'Checker 故障', output=preview(output), expected=preview(answer))
    log = root / 'logs' / ('run_checker_' + case['id'] + '_' + role + '_stdout.stderr')
    if log.exists():
        result['log'] = preview(log)
        paths['logs'].append(str(log.relative_to(root)))
    return result

def verify(case):
    input_path = root / case['inputPath']
    if not validate_input(input_path, case['id']): raise RuntimeError('Validator 拒绝输入')
    answer = root / 'answers' / (case['id'] + '.out')
    baseline_ok = 'reference' in commands and program('reference', input_path, answer, case['id'])
    if not baseline_ok and payload.get('stress'): raise RuntimeError('基准程序运行失败或无法生成答案')
    if not baseline_ok and not case.get('outputPath'):
        return [publish_cell(cell(item, 'candidate' + str(index), case, input_path, None)) for index, item in enumerate(payload['solutions'])]
    supplied = root / case['outputPath'] if case.get('outputPath') else answer
    if baseline_ok:
        score = checker_score(input_path, answer, supplied, 'baseline', case['id']) if 'checker' in commands else (100 if same_default(answer, supplied) else 0)
        if score != 100 and (payload.get('stress') or not case.get('outputPath')): raise RuntimeError('基准程序与答案或 Checker 不相容')
    found = []
    for index, item in enumerate(payload['solutions']):
        found.append(publish_cell(cell(item, 'candidate' + str(index), case, input_path, supplied)))
    return found

def main():
    global cells, stress
    for role in ('reference', 'checker', 'validator', 'generator'):
        item = payload.get(role)
        if item and not source(role, item['language'], item['code']):
            if role != 'reference' or payload.get('stress'): raise RuntimeError(role + ' 编译失败')
    for index, item in enumerate(payload['solutions']):
        role = 'candidate' + str(index)
        if item['id'] == payload['primaryId']:
            if 'reference' in commands:
                commands[role] = commands['reference']; languages[role] = languages['reference']
            else:
                check('compile:' + role, False, next(item['message'] for item in checks if item['stage'] == 'compile:reference'), verdict='CE')
        else: source(role, item['language'], item['code'])
    if not payload.get('stress'):
        for case in payload['cases']:
            try: cells.extend(verify(case))
            except Exception as error:
                cells.extend(publish_cell({'solutionId':item['id'], 'caseId':case['key'], 'verdict':'SYSTEM_ERROR', 'score':0, 'durationMs':0, 'message':str(error)}) for item in payload['solutions'])
        return
    spec = payload['stress']
    stress = {'completedRounds':0, 'reason':'rounds', 'message':'已完成指定轮数，未发现反例。', 'cells':[]}
    if any('candidate' + str(index) not in commands for index in range(len(payload['solutions']))): raise RuntimeError('待测程序编译失败')
    for round in range(1 if payload.get('replay') else spec['rounds']):
        seed = payload['replay']['seed'] if payload.get('replay') else spec['seed'] + round
        args = payload['replay']['args'] if payload.get('replay') else [arg.replace('{seed}', str(seed)) for arg in spec['args']]
        first, second = root / 'counterexample.in', root / 'repeat.in'
        if not payload.get('replay'):
            left = run(commands['generator'] + args, None, first, 30, 512, root / 'generator')
            right = run(commands['generator'] + args, None, second, 30, 512, root / 'generator-repeat')
            if left['status'] != 'ok' or right['status'] != 'ok': raise RuntimeError('生成器运行失败')
            if not same_file(first, second): raise RuntimeError('相同种子生成的输入不一致')
        found = verify({'id':'stress', 'key':'stress', 'inputPath':'counterexample.in'})
        stress['completedRounds'] += 1
        check('stress-round', True, '已完成 ' + str(stress['completedRounds']) + ' 轮')
        if any(item['verdict'] == 'SYSTEM_ERROR' for item in found): raise RuntimeError('Checker 故障')
        if any(item['verdict'] != 'AC' or item['score'] != 100 for item in found):
            shutil.copyfile(root / 'answers' / 'stress.out', root / 'counterexample.out')
            stress.update(reason='counterexample', message='发现反例。', seed=seed, args=args, cells=found,
                          inputPreview=preview(first), outputPreview=preview(root / 'counterexample.out'),
                          truncated=first.stat().st_size > 2048 or (root / 'counterexample.out').stat().st_size > 2048)
            return

try: main()
except BudgetEnd:
    stress = stress or {'completedRounds':0, 'cells':[]}
    stress.update(reason='budget', message='已达到时间预算。')
except Exception as error:
    check('verification-system', False, str(error), verdict='SYSTEM_ERROR')
    if payload.get('stress'):
        stress = stress or {'completedRounds':0, 'cells':[]}
        stress.update(reason='error', message=str(error))
(root / 'matrix-result.json').write_text(json.dumps({'cells':cells, 'checks':checks, 'stress':stress}, ensure_ascii=False))
`;

export async function runSolutionSandbox(input: SolutionSandboxInput): Promise<SolutionSandboxResult> {
	const parent = input.context;
	input = {
		...input,
		context: {
			id: parent?.id ?? randomUUID(),
			signal: parent?.signal ?? new AbortController().signal,
			observability: parent?.observability,
			emit(type, message, data) {
				parent?.emit(type, message, data);
				if (type !== "check") return;
				const check = readSandboxCheck(data);
				input.onProgress?.({ check });
				if (!input.interactor) return;
				for (const [index, solution] of input.solutions.entries()) {
					const role = `candidate${index}`;
					for (const test of input.cases ?? []) {
						if (
							(check.stage === `interaction:${role}` && check.caseId === test.id) ||
							(check.stage === `compile:${role}` && !check.passed)
						) {
							input.onProgress?.({ cell: interactiveCell(solution.id, test.id, role, check) });
						}
					}
				}
			},
		},
	};
	if (input.interactor) {
		const report = await runInteractiveSandbox({
			...input,
			contestants: input.solutions.map((item) => ({ id: item.id, program: item })),
		});
		const cells: MatrixCell[] = [];
		for (const [index, solution] of input.solutions.entries())
			for (const test of input.cases ?? []) {
				const role = `candidate${index}`;
				const compile = report.checks.find((item) => item.stage === `compile:${role}` && !item.passed);
				const result =
					report.checks.find((item) => item.stage === `interaction:${role}` && item.caseId === test.id) ?? compile;
				const log = await readFile(join(input.stage, "logs", `${role}-${test.id}.json`), "utf8").catch(() => "");
				const value = { ...interactiveCell(solution.id, test.id, role, result), log: log.slice(0, 8000) };
				cells.push(value);
				input.onProgress?.({ cell: value });
			}
		return { cells, checks: report.checks };
	}
	await mkdir(input.stage, { recursive: true });
	await chmod(input.stage, 0o777);
	await mkdir(join(input.stage, "cases"), { recursive: true });
	const cases = [];
	for (const [index, item] of (input.cases ?? []).entries()) {
		await copyFile(item.inputPath, join(input.stage, "cases", `${index}.in`));
		if (item.outputPath) await copyFile(item.outputPath, join(input.stage, "cases", `${index}.out`));
		cases.push({
			id: String(index),
			key: item.id,
			inputPath: `cases/${index}.in`,
			outputPath: item.outputPath ? `cases/${index}.out` : undefined,
		});
	}
	if (input.replay) await copyFile(input.replay.inputPath, join(input.stage, "counterexample.in"));
	await writeFile(join(input.stage, "runner.py"), runner);
	await writeFile(
		join(input.stage, "payload.json"),
		JSON.stringify({
			reference: input.reference,
			primaryId: input.primaryId,
			solutions: input.solutions,
			checker: input.checker ? { code: input.checker, language: input.checkerStandard } : undefined,
			validator: input.validator ? { code: input.validator, language: input.validatorStandard } : undefined,
			generator: input.generator ? { code: input.generator, language: input.generatorStandard } : undefined,
			cases,
			stress: input.stress,
			replay: input.replay ? { seed: input.replay.seed, args: input.replay.args } : undefined,
			timeLimitMs: input.timeLimitMs,
			memoryLimitMb: input.memoryLimitMb,
			maxFileBytes: input.maxFileBytes,
			maxTotalBytes: 512 * 1024 * 1024,
		}),
	);
	const taskId = input.context?.id ?? randomUUID();
	await runDocker(
		[
			"run",
			"--rm",
			"--name",
			`setdraft-task-${taskId}`,
			...(input.sandboxArgs ?? sandboxRuntimeArgs()),
			"--mount",
			`type=bind,source=${input.stage},target=/work`,
			"--entrypoint",
			"python3",
			input.image,
			"/work/runner.py",
		],
		sandboxPolicy().runTimeoutMs,
		input.context?.signal,
		taskId,
		input.context,
		input.stage,
		(value) => input.onProgress?.({ cell: readCells([value])[0] }),
	);
	const raw: unknown = JSON.parse(
		(await readSandboxFile(input.stage, "matrix-result.json", 64 * 1024 * 1024, input.context?.signal)).toString(
			"utf8",
		),
	);
	return readSolutionResult(raw);
}

function interactiveCell(solutionId: string, caseId: string, role: string, result?: ManualCheck): MatrixCell {
	return {
		solutionId,
		caseId,
		verdict: result?.verdict ?? "SYSTEM_ERROR",
		score: result?.score ?? (result?.passed ? 100 : 0),
		scoreRatio: result?.scoreRatio,
		durationMs: result?.durationMs ?? 0,
		message: result?.message ?? "测试未完成",
		artifacts: { logs: [`logs/${role}.compile.txt`, `logs/${role}-${caseId}.json`] },
	};
}

function readArtifacts(value: unknown): MatrixCell["artifacts"] {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	const path = (raw: unknown): string | undefined => {
		if (raw === undefined) return undefined;
		if (typeof raw !== "string" || !/^(logs|outputs|answers|cases)\/[A-Za-z0-9_.:-]+$/u.test(raw) || raw.length > 400)
			throw new Error("诊断文件路径无效。");
		return raw;
	};
	if (!Array.isArray(item.logs) || item.logs.length > 10) throw new Error("诊断日志无效。");
	return { output: path(item.output), expected: path(item.expected), logs: item.logs.map((item) => path(item)!) };
}

export function readSolutionResult(value: unknown): SolutionSandboxResult {
	if (!value || typeof value !== "object") throw new Error("验证结果无效。");
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.cells) || !Array.isArray(raw.checks)) throw new Error("验证结果无效。");
	const cells = readCells(raw.cells);
	const checks = raw.checks.map(readSandboxCheck);
	let stress: StressReport | undefined;
	if (raw.stress) {
		const item = raw.stress as Record<string, unknown>;
		if (
			!Number.isSafeInteger(item.completedRounds) ||
			Number(item.completedRounds) < 0 ||
			!["counterexample", "rounds", "budget", "error"].includes(String(item.reason)) ||
			typeof item.message !== "string" ||
			!Array.isArray(item.cells)
		)
			throw new Error("对拍结果无效。");
		if (
			item.reason === "counterexample" &&
			(!Number.isSafeInteger(item.seed) ||
				!Array.isArray(item.args) ||
				item.args.some((arg) => typeof arg !== "string"))
		)
			throw new Error("反例参数无效。");
		stress = {
			completedRounds: Number(item.completedRounds),
			reason: item.reason as StressReport["reason"],
			message: item.message.slice(0, 3000),
			cells: readCells(item.cells),
			seed: typeof item.seed === "number" ? item.seed : undefined,
			args: Array.isArray(item.args) ? (item.args as string[]) : undefined,
			inputPreview: typeof item.inputPreview === "string" ? item.inputPreview.slice(0, 2048) : undefined,
			outputPreview: typeof item.outputPreview === "string" ? item.outputPreview.slice(0, 2048) : undefined,
			truncated: item.truncated === true,
		};
	}
	return { cells, checks, stress };
}

function readCells(values: unknown[]): MatrixCell[] {
	if (values.length > 10000) throw new Error("矩阵结果超过上限。");
	return values.map((value) => {
		if (!value || typeof value !== "object") throw new Error("验证单元无效。");
		const item = value as Record<string, unknown>;
		if (
			typeof item.solutionId !== "string" ||
			typeof item.caseId !== "string" ||
			!["AC", "WA", "CE", "RE", "TLE", "SYSTEM_ERROR"].includes(String(item.verdict)) ||
			typeof item.score !== "number" ||
			!Number.isFinite(item.score) ||
			item.score < 0 ||
			item.score > 100 ||
			(item.scoreRatio !== undefined &&
				(typeof item.scoreRatio !== "number" ||
					!Number.isFinite(item.scoreRatio) ||
					item.scoreRatio < 0 ||
					item.scoreRatio > 1)) ||
			typeof item.durationMs !== "number" ||
			!Number.isFinite(item.durationMs) ||
			item.durationMs < 0 ||
			typeof item.message !== "string"
		)
			throw new Error("验证单元无效。");
		return {
			solutionId: item.solutionId,
			caseId: item.caseId,
			verdict: item.verdict as MatrixCell["verdict"],
			score: item.score,
			scoreRatio: typeof item.scoreRatio === "number" ? item.scoreRatio : undefined,
			durationMs: item.durationMs,
			message: item.message.slice(0, 3000),
			output: typeof item.output === "string" ? item.output.slice(0, 2048) : undefined,
			expected: typeof item.expected === "string" ? item.expected.slice(0, 2048) : undefined,
			log: typeof item.log === "string" ? item.log.slice(0, 8000) : undefined,
			artifacts: readArtifacts(item.artifacts),
		};
	});
}
