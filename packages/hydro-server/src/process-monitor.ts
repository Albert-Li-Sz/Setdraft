/** Linux per-process-group accounting, shared by ordinary and interactive runners. */
export const pythonProcessMonitor = `
def group_memory(group):
    total = 0
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group: total += int(fields[21]) * os.sysconf('SC_PAGE_SIZE')
        except (OSError, ValueError, IndexError): pass
    return total

def wait_program(process, timeout, memory_mb, on_sample=None):
    started = time.monotonic()
    peak = 0
    status = 'ok'
    last_sample = started
    cap = memory_mb * 1048576 if memory_mb is not None else None
    while True:
        pid, state, usage = os.wait4(process.pid, os.WNOHANG)
        if pid:
            process.returncode = os.waitstatus_to_exitcode(state)
            peak = max(peak, int(usage.ru_maxrss * 1024))
            break
        peak = max(peak, group_memory(process.pid))
        if on_sample and time.monotonic() - last_sample >= 0.02:
            on_sample(peak)
            last_sample = time.monotonic()
        if cap is not None and peak > cap: status = 'memory_limit'
        elif time.monotonic() - started >= timeout: status = 'time_limit'
        if status != 'ok':
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            _, state, usage = os.wait4(process.pid, 0)
            process.returncode = os.waitstatus_to_exitcode(state)
            peak = max(peak, int(usage.ru_maxrss * 1024))
            break
        time.sleep(0.002)
    try: os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    if cap is not None and peak > cap: status = 'memory_limit'
    elif status == 'ok' and process.returncode == -signal.SIGXCPU: status = 'time_limit'
    elif status == 'ok' and process.returncode != 0: status = 'runtime_error'
    return {'status':status, 'code':process.returncode, 'memoryBytes':peak,
            'durationMs':round((time.monotonic() - started)*1000)}
`;
