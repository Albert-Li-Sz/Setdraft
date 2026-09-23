import { sandboxProcessRunner } from "./sandbox-runner.ts";

/** One container compiles each authoring component once, then materializes and verifies the data. */
export const authoringRunner =
	sandboxProcessRunner +
	String.raw`
import re, zipfile, io, threading
output_limit = 16 * 1024 * 1024
checks, data = [], []
wrong_scores = {}
commands = {}
languages = {}
total_bytes = 0
mode = payload.get('verificationMode', 'full')

def record(stage, passed, message='', case_id=None):
    checks.append({'stage': stage, 'caseId': case_id, 'passed': passed, 'message': message[:4000]})
    return passed

def detail(run):
    return run['status'] + ': ' + (run.get('stderr') or run.get('stdout') or '')[:3500]

def compile_program(role, program):
    directory = root / role
    directory.mkdir()
    lang = program['language']
    languages[role] = lang
    source = directory / {'cpp17': 'main.cpp', 'python3': 'main.py', 'java': 'Main.java'}[lang]
    source.write_text(program['code'], encoding='utf-8')
    compile_cmd = {
        'cpp17': ['g++', '-std=c++17', '-O2', '-pipe', '-I/opt/testlib', str(source), '-o', str(directory / 'main')],
        'python3': ['python3', '-m', 'py_compile', str(source)],
        'java': ['javac', '-J-Xmx256m', str(source)]
    }[lang]
    compiled = execute(compile_cmd, '', 40, None, directory / 'compile')
    commands[role] = {
        'cpp17': [str(directory / 'main')],
        'python3': ['python3', '-I', str(source)],
        'java': ['java', '-XX:ActiveProcessorCount=1', '-XX:+UseSerialGC', '-XX:CompressedClassSpaceSize=32m',
                 '-XX:ReservedCodeCacheSize=32m', '-cp', str(directory), 'Main']
    }[lang]
    return record('compile:' + role, compiled['status'] == 'ok', detail(compiled))

def run_program(role, text, directory, timeout=5, memory=512, args=None):
    cmd = commands[role][:]
    if languages[role] == 'java':
        cmd.insert(1, '-Xmx' + str(memory) + 'm')
    return execute(cmd + (args or []), text, timeout,
                   None if languages[role] == 'java' else memory, directory)

def normalized(text):
    lines = [line.rstrip(' \t') for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    while lines and lines[-1] == '':
        lines.pop()
    return lines

def judge(text, answer, contestant, directory):
    if not payload.get('checker'):
        return (100 if normalized(answer) == normalized(contestant) else 0, '')
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in [('input', text), ('answer', answer), ('contestant', contestant)]:
        (directory / name).write_text(content, encoding='utf-8')
    result = run_program('checker', '', directory / 'run', args=[str(directory / 'input'), str(directory / 'contestant'), str(directory / 'answer')])
    shutil.rmtree(directory, ignore_errors=True)
    # Mirror Hydro's testlib score parsing. A crash, _fail or timeout is never a valid WA.
    if result['status'] == 'ok' and result['exitCode'] == 0 and result['stderr'].startswith('ok'):
        override = re.search(r'\bscore\((\d+)\)', result['stderr'])
        return (int(override.group(1)) if override else 100, result['stderr'])
    if result['status'] == 'runtime_error' and result['exitCode'] in (1, 2) and result['stderr'].startswith(('wrong answer', 'wrong output format')):
        override = re.search(r'\bscore\((\d+)\)', result['stderr'])
        return (int(override.group(1)) if override else 0, result['stderr'])
    partial = re.match(r'^partially correct \((\d+)\)', result['stderr'])
    points = re.match(r'^points ([\d.]+)', result['stderr'])
    if result['status'] == 'runtime_error' and (partial or points):
        fraction = float((partial or points).group(1))
        if fraction > 1: fraction /= 100
        if 0 <= fraction <= 1:
            score = int(100 * fraction)
            override = re.search(r'\bscore\((\d+)\)', result['stderr'])
            if override: score = int(override.group(1))
            if 0 <= score <= 100: return (score, result['stderr'])
    return (None, detail(result))

def run_interaction(role, text, directory, timeout=5, memory=512):
    directory.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    current_input, state = text, None
    max_passes = payload.get('multiPass', 1)
    for pass_number in range(1, max_passes + 1):
        round_dir = directory / ('pass-' + str(pass_number))
        round_dir.mkdir()
        input_file, output_file, transcript_file = round_dir / 'in', round_dir / 'out', round_dir / 'tout'
        input_file.write_text(current_input, encoding='utf-8')
        output_file.write_text('', encoding='utf-8')
        if state is not None: (round_dir / 'state.txt').write_bytes(state)
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit, output_limit))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(timeout) + 1, math.ceil(timeout) + 1))
            resource.setrlimit(resource.RLIMIT_AS, (memory * 1024 * 1024, memory * 1024 * 1024))
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/tmp',
               'HYDRO_TESTCASE': directory.name, 'HYDRO_MULTI_PASS': str(pass_number) if payload.get('multiPass') else ''}
        contestant_cmd = commands[role][:]
        if languages[role] == 'java': contestant_cmd.insert(1, '-Xmx' + str(memory) + 'm')
        with open(round_dir / 'contestant.err', 'wb') as contestant_err, open(round_dir / 'interactor.err', 'wb') as interactor_err:
            contestant = subprocess.Popen(contestant_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=contestant_err, cwd=round_dir, env=env,
                                           start_new_session=True, preexec_fn=None if languages[role] == 'java' else limits)
            interactor = subprocess.Popen(commands['interactor'] + [str(input_file), str(transcript_file), str(output_file)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=interactor_err,
                                           cwd=round_dir, env=env, start_new_session=True, preexec_fn=limits)
            traffic = [0, 0]
            def relay(source, target, index):
                try:
                    while True:
                        chunk = os.read(source.fileno(), 4096)
                        if not chunk: break
                        traffic[index] += len(chunk)
                        if traffic[index] > output_limit: break
                        target.write(chunk)
                        target.flush()
                except (BrokenPipeError, OSError, ValueError):
                    pass
                finally:
                    try: target.close()
                    except OSError: pass
            threads = [threading.Thread(target=relay, args=(contestant.stdout, interactor.stdin, 0), daemon=True),
                       threading.Thread(target=relay, args=(interactor.stdout, contestant.stdin, 1), daemon=True)]
            for thread in threads: thread.start()
            timed_out = False
            while contestant.poll() is None or interactor.poll() is None:
                if time.monotonic() - started > timeout * pass_number or max(traffic) > output_limit:
                    timed_out = True
                    break
                time.sleep(.01)
            for process in (contestant, interactor):
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait()
            for thread in threads: thread.join(timeout=.2)
        stderr = (round_dir / 'interactor.err').read_text(encoding='utf-8', errors='replace')[:4000]
        elapsed = round((time.monotonic() - started) * 1000)
        if timed_out:
            return {'status': 'time_limit' if max(traffic) <= output_limit else 'output_limit', 'stdout': '',
                    'stderr': stderr or '交互超时或通信量超限', 'durationMs': elapsed}
        if contestant.returncode not in (0, -13) and interactor.returncode == 0:
            return {'status': 'runtime_error', 'stdout': '', 'stderr': 'contestant exit ' + str(contestant.returncode), 'durationMs': elapsed}
        if stderr.startswith('wrong answer ') or stderr.startswith('wrong output format '):
            override = re.search(r'\bscore\((\d+)\)', stderr)
            score = int(override.group(1)) if override else 0
            return {'status': 'wrong_answer' if score == 0 else 'partial', 'score': score,
                    'stdout': '', 'stderr': stderr, 'durationMs': elapsed}
        partial = re.match(r'^partially correct \((\d+)\)', stderr)
        points = re.match(r'^points ([\d.]+)', stderr)
        if partial or points:
            fraction = float((partial or points).group(1))
            if fraction > 1: fraction /= 100
            if 0 <= fraction <= 1:
                score = int(100 * fraction)
                override = re.search(r'\bscore\((\d+)\)', stderr)
                if override: score = int(override.group(1))
                return {'status': 'ok' if score == 100 else ('wrong_answer' if score == 0 else 'partial'),
                        'score': score, 'stdout': '', 'stderr': stderr, 'durationMs': elapsed}
        if not stderr.startswith('ok ') or interactor.returncode != 0:
            return {'status': 'interactor_error', 'stdout': '', 'stderr': stderr or 'interactor did not return testlib verdict', 'durationMs': elapsed}
        nextpass = round_dir / 'nextpass.in'
        if nextpass.exists():
            if pass_number == max_passes:
                return {'status': 'interactor_error', 'stdout': '', 'stderr': 'Exceeded maximum number of passes', 'durationMs': elapsed}
            current_input = nextpass.read_text(encoding='utf-8')
            state_file = round_dir / 'state.txt'
            state = state_file.read_bytes() if state_file.exists() else None
            continue
        if payload.get('multiPass') and pass_number < 2:
            return {'status': 'interactor_error', 'stdout': '', 'stderr': 'Multi-pass was configured but no nextpass.in was produced', 'durationMs': elapsed}
        override = re.search(r'\bscore\((\d+)\)', stderr)
        score = int(override.group(1)) if override else 100
        return {'status': 'ok' if score == 100 else ('wrong_answer' if score == 0 else 'partial'),
                'score': score, 'stdout': '', 'stderr': stderr, 'durationMs': elapsed}
    return {'status': 'interactor_error', 'stdout': '', 'stderr': 'No final pass', 'durationMs': round((time.monotonic() - started) * 1000)}

def main():
    global total_bytes
    programs = {'reference': payload['reference'], 'oracle': payload['oracle'],
                'generator': {'language': 'cpp17', 'code': payload['generator']},
                'validator': {'language': 'cpp17', 'code': payload['validator']}}
    if payload.get('checker'):
        programs['checker'] = {'language': 'cpp17', 'code': payload['checker']}
    if payload.get('interactor'):
        programs['interactor'] = {'language': 'cpp17', 'code': payload['interactor']}
        programs['timeout-probe'] = {'language': 'python3', 'code': 'import time\nwhile True: time.sleep(1)'}
    if payload.get('queryLimitProbe'):
        programs['query-limit-probe'] = payload['queryLimitProbe']
    for index, item in enumerate(payload['wrongPrograms']):
        programs['wrong-' + str(index)] = item['program']
    for role, program in programs.items():
        if not compile_program(role, program):
            return
    invalid_inputs = payload['invalidInputs'] if mode == 'full' else payload['invalidInputs'][:8]
    for index, text in enumerate(invalid_inputs):
        invalid = run_program('validator', text, root / ('invalid-' + str(index)))
        record('validator-negative', invalid['status'] == 'runtime_error' and invalid['exitCode'] == 3
               and invalid['stderr'].startswith('FAIL'), detail(invalid), str(index + 1))
    killed = set()
    cases = payload['cases']
    if mode == 'quick':
        preferred = [case for case in cases if case.get('purpose') == 'sample' or case.get('oracle')]
        cases = (preferred + [case for case in cases if case not in preferred])[:8]
    for case in cases:
        case_id = case['id']
        directory = root / ('case-' + case_id)
        directory.mkdir()
        text = case.get('input', '')
        if 'generatorArgs' in case:
            gen = run_program('generator', '', directory / 'generate', args=case['generatorArgs'])
            if not record('generator', gen['status'] == 'ok',
                          ('ok: ' + str(len(gen['stdout'].encode('utf-8'))) + ' bytes') if gen['status'] == 'ok' else detail(gen), case_id):
                continue
            text = gen['stdout']
            repeated = run_program('generator', '', directory / 'repeat', args=case['generatorArgs'])
            if not record('reproducibility', repeated['status'] == 'ok' and repeated['stdout'] == text,
                          '固定参数重跑一致' if repeated['status'] == 'ok' and repeated['stdout'] == text else detail(repeated), case_id):
                continue
        valid = run_program('validator', text, directory / 'validate')
        if not record('validator', valid['status'] == 'ok', 'ok' if valid['status'] == 'ok' else detail(valid), case_id):
            continue
        time_ms = case.get('timeLimitMs', payload['timeLimitMs'])
        memory = case.get('memoryLimitMb', payload['memoryLimitMb'])
        if payload.get('type') == 'interactive':
            ref = run_interaction('reference', text, directory / 'reference', time_ms / 1000, memory)
        else:
            ref = run_program('reference', text, directory / 'reference', time_ms / 1000, memory)
        if not record('reference', ref['status'] == 'ok',
                      ('ok: ' + str(len(ref['stdout'].encode('utf-8'))) + ' bytes, ' + str(ref['durationMs']) + ' ms') if ref['status'] == 'ok' else detail(ref), case_id):
            continue
        answer = ref['stdout']
        judge_input = (case.get('submissionFile', '') + '\n') if payload.get('type') == 'submit_answer' and payload.get('answerMode') == 'multi' else ('' if payload.get('type') == 'submit_answer' else text)
        score, message = (100, 'interactive accepted') if payload.get('type') == 'interactive' else judge(judge_input, answer, answer, directory / 'self-check')
        if not record('checker-self', score == 100, message, case_id):
            continue
        if payload.get('type') == 'submit_answer':
            if payload.get('answerMode') == 'multi':
                memory_zip = io.BytesIO()
                with zipfile.ZipFile(memory_zip, 'w') as archive:
                    archive.writestr(case['submissionFile'], answer)
                with zipfile.ZipFile(io.BytesIO(memory_zip.getvalue())) as archive:
                    extracted = archive.read(case['submissionFile']).decode('utf-8')
                record('submission-zip', extracted == answer, '正确答案 ZIP 可按 .in 指定文件提取', case_id)
                missing_zip = io.BytesIO()
                with zipfile.ZipFile(missing_zip, 'w') as archive:
                    archive.writestr('unrelated.txt', answer)
                try:
                    with zipfile.ZipFile(io.BytesIO(missing_zip.getvalue())) as archive:
                        archive.read(case['submissionFile'])
                    missing = False
                except KeyError:
                    missing = True
                record('submission-missing', missing, '缺失文件被判为零分', case_id)
                try:
                    zipfile.ZipFile(io.BytesIO(b'not-a-zip')).namelist()
                    invalid_archive = False
                except zipfile.BadZipFile:
                    invalid_archive = True
                record('submission-invalid-zip', invalid_archive, '损坏的 ZIP 被拒绝', case_id)
            else:
                record('submission-single', score == 100, '单文件答案可直接判分', case_id)
            invalid_answer = answer + '\n__definitely_wrong_extra_token__\n'
            invalid_score, invalid_message = judge(judge_input, answer, invalid_answer, directory / 'submission-wrong')
            record('submission-wrong', invalid_score is not None and invalid_score < 100, invalid_message, case_id)
        if 'expectedOutput' in case and payload.get('type') != 'interactive':
            score, message = judge(judge_input, case['expectedOutput'], answer, directory / 'sample-check')
            reverse, reverse_message = judge(judge_input, answer, case['expectedOutput'], directory / 'sample-reverse')
            record('sample', score == 100 and reverse == 100, message + reverse_message or ('expected: ' + case['expectedOutput'][:500] + '\nactual: ' + answer[:500]), case_id)
        if case.get('oracle'):
            oracle = run_interaction('oracle', text, directory / 'oracle', 10, 512) if payload.get('type') == 'interactive' else run_program('oracle', text, directory / 'oracle', 10, 512)
            if record('oracle-run', oracle['status'] == 'ok',
                      ('ok: ' + str(len(oracle['stdout'].encode('utf-8'))) + ' bytes') if oracle['status'] == 'ok' else detail(oracle), case_id):
                if payload.get('type') == 'interactive':
                    record('oracle', True, '独立交互程序通过同一交互器', case_id)
                else:
                    score, message = judge(judge_input, oracle['stdout'], answer, directory / 'oracle-check')
                    reverse, reverse_message = judge(judge_input, answer, oracle['stdout'], directory / 'oracle-reverse')
                    record('oracle', score == 100 and reverse == 100, message or reverse_message or
                           ('reference: ' + answer[:500] + '\noracle: ' + oracle['stdout'][:500]), case_id)
        for index, item in enumerate(payload['wrongPrograms']):
            if index in killed and (mode != 'full' or 'maxScore' not in item):
                continue
            wrong = run_interaction('wrong-' + str(index), text, directory / ('wrong-' + str(index)), time_ms / 1000, memory) if payload.get('type') == 'interactive' else run_program('wrong-' + str(index), text, directory / ('wrong-' + str(index)), time_ms / 1000, memory)
            if wrong['status'] in ('wrong_answer', 'partial', 'runtime_error', 'time_limit', 'output_limit'):
                wrong_scores.setdefault(item['name'], {})[case_id] = wrong.get('score', 0)
                if index not in killed:
                    killed.add(index)
                    record('wrong-program-killed', True, item['name'] + ': ' + detail(wrong), case_id)
            elif wrong['status'] != 'ok':
                record('interactor-error', False, item['name'] + ': ' + detail(wrong), case_id)
            else:
                score, message = (100, '') if payload.get('type') == 'interactive' else judge(judge_input, answer, wrong['stdout'], directory / ('wrong-check-' + str(index)))
                if score is None:
                    record('checker-error', False, message, case_id)
                else:
                    wrong_scores.setdefault(item['name'], {})[case_id] = score
                    if score < 100 and index not in killed:
                        killed.add(index)
                        record('wrong-program-killed', True, item['name'] + ': ' + message, case_id)
        for index, probe in enumerate(payload.get('checkerProbes', [])):
            if probe['caseId'] != case_id:
                continue
            score, message = judge(judge_input, answer, probe['output'], directory / ('probe-' + str(index)))
            expected_score = probe.get('score', 100 if probe['accept'] else 0)
            record('checker-probe', score == expected_score, probe['description'] + ': ' + message, case_id)
        total_bytes += len(text.encode('utf-8')) + len(answer.encode('utf-8'))
        if total_bytes > 64 * 1024 * 1024:
            record('data-size', False, '本次制题数据总量超过 64 MiB。', case_id)
            return
        data.append({'id': case_id, 'input': text, 'output': answer, 'durationMs': ref['durationMs'],
                     'timeLimitMs': time_ms, 'memoryLimitMb': memory})
        if payload.get('type') == 'interactive' and mode == 'full' and case_id == cases[0]['id']:
            timeout_probe = run_interaction('timeout-probe', text, root / ('timeout-probe-' + case_id), min(time_ms / 1000, 2), memory)
            record('interaction-timeout', timeout_probe['status'] == 'time_limit', detail(timeout_probe), case_id)
            if payload.get('queryLimitProbe'):
                query_probe = run_interaction('query-limit-probe', text, root / ('query-probe-' + case_id), time_ms / 1000, memory)
                record('interaction-query-limit', query_probe['status'] == 'wrong_answer', detail(query_probe), case_id)
        shutil.rmtree(directory)
    if mode == 'full':
        for index, item in enumerate(payload['wrongPrograms']):
            if index not in killed:
                record('wrong-program-survived', False, item['name'] + ': 所有测试点均通过，需要加强数据。')

try:
    main()
except Exception as error:
    record('infrastructure', False, str(error))
expected_cases = len(payload['cases']) if mode == 'full' else min(8, len(payload['cases']))
toolchain = {}
for name, command in [('g++', ['g++', '--version']), ('python3', ['python3', '--version']), ('javac', ['javac', '-version'])]:
    try:
        version = subprocess.run(command, capture_output=True, text=True, timeout=3)
        toolchain[name] = (version.stdout or version.stderr).splitlines()[0]
    except Exception as error:
        toolchain[name] = str(error)
print(json.dumps({'success': len(data) == expected_cases and all(item['passed'] for item in checks),
                  'mode': mode, 'checks': checks, 'cases': data, 'toolchain': toolchain,
                  'wrongScores': wrong_scores}, ensure_ascii=False))
`;
