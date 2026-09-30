import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHydroTimeLimitMs, writeStoredArchiveFromFiles } from "@setdraft/authoring";
import { isContestReadyRelease } from "@setdraft/contracts";
import { runInteractiveSandbox } from "./interactive-sandbox.ts";
import type { ManualProject, ManualRelease } from "./manual-projects.ts";
import type { CppLanguage } from "./manual-sandbox.ts";
import { cleanupSandboxStage, removeDockerContainer, sandboxRuntimeArgs } from "./sandbox-runtime.ts";

interface SourceManifest {
	cases: Array<{ inputFile: string; outputFile: string }>;
}

const standardNames: Record<CppLanguage, string> = {
	cpp11: "c++11",
	cpp14: "c++14",
	cpp17: "c++17",
	cpp20: "c++20",
	cpp23: "c++23",
	cpp26: "c++26",
};

export function domjudgeProblemId(releaseId: string): string {
	return `p${releaseId.replaceAll("-", "")}`;
}

function buildScript(standard: CppLanguage, role = "checker"): string {
	return [
		"#!/bin/sh",
		"set -eu",
		'cd "$(dirname "$0")"',
		`g++ -std=${standardNames[standard]} -O2 -pipe -I. ${role}.cc -o ${role}`,
		"",
	].join("\n");
}

const runScript = [
	"#!/bin/sh",
	"set -u",
	'validator_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)',
	"output=$(mktemp)",
	"trap 'rm -f \"$output\"' EXIT HUP INT TERM",
	'cat > "$output"',
	'"$validator_dir/checker" "$1" "$output" "$2" 2> "$3/judgemessage.txt"',
	"status=$?",
	'case "$status" in',
	"  0) exit 42 ;;",
	"  1|2|7) exit 43 ;;",
	"  *) exit 1 ;;",
	"esac",
	"",
].join("\n");

const interactiveRunScript = [
	"#!/bin/sh",
	"set -u",
	'validator_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)',
	'"$validator_dir/interactor" "$1" "$3/transcript" "$2" 2> "$3/judgemessage.txt"',
	"status=$?",
	'cat "$3/judgemessage.txt" >&2',
	`awk -v status="$status" '
NR == 1 {
    if (status == 0 && /^ok[[:space:]]/) { valid = 1; score = 100 }
    else if ((status == 1 || status == 2) && /^(wrong answer|wrong output format)[[:space:]]/) { valid = 1; score = 0 }
    else if (status == 7 && /^points [0-9.]+/) { valid = 1; score = $2; if (score <= 1) score *= 100 }
    else if (/^partially correct \\([0-9.]+\\)/) {
        value = $3; gsub(/[()]/, "", value)
        if (status == value) { valid = 1; score = value; if (score <= 1) score *= 100 }
    }
}
match($0, /score\\(-?[0-9]+\\)/) { value = substr($0, RSTART + 6, RLENGTH - 7); score = value + 0 }
END { if (!valid || score < 0 || score > 100) exit 1; if (score == 100) exit 42; exit 43 }
' "$3/judgemessage.txt"`,
	"",
].join("\n");

function spawnDocker(
	args: string[],
	timeoutMs: number,
	signal: AbortSignal | undefined,
	containerName: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const command = [...args.slice(0, 1), "--name", containerName, ...args.slice(1)];
		const child = spawn("docker", command, { stdio: ["ignore", "pipe", "pipe"] });
		const errors: Buffer[] = [];
		let stopping: Promise<void> | undefined;
		const stop = () => {
			if (stopping) return;
			stopping = removeDockerContainer(containerName);
			void stopping.catch(() => {});
			child.kill("SIGKILL");
		};
		const timer = setTimeout(stop, timeoutMs);
		signal?.addEventListener("abort", stop, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
		};
		child.stderr.on("data", (chunk: Buffer) => {
			if (errors.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) errors.push(chunk);
		});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", async (code) => {
			cleanup();
			try {
				if (stopping) {
					await stopping.catch(() => undefined);
					await removeDockerContainer(containerName);
				}
			} catch (error) {
				reject(error);
				return;
			}
			if (code === 0 && !stopping) resolve();
			else
				reject(
					new Error(Buffer.concat(errors).toString("utf8").slice(0, 4000) || `DOMjudge Checker 验证失败：${code}`),
				);
		});
		if (signal?.aborted) stop();
	});
}

async function verifyOutputValidator(
	directory: string,
	image: string,
	caseCount: number,
	signal?: AbortSignal,
	containerName = `setdraft-export-${randomUUID()}`,
): Promise<void> {
	const verify = [
		"import pathlib, shutil, subprocess, tempfile",
		"root = pathlib.Path('/package')",
		"validator = pathlib.Path(tempfile.mkdtemp()) / 'checker'",
		"shutil.copytree(root / 'output_validators' / 'checker', validator)",
		"subprocess.run([str(validator / 'build')], check=True, cwd=validator, timeout=60)",
		"checker = validator / 'checker'",
		"run = validator / 'run'",
		"input_paths = sorted((root / 'data' / 'secret').glob('*.in'))",
		"if not input_paths: raise RuntimeError('DOMjudge package has no test inputs')",
		"for input_path in input_paths:",
		"    answer = input_path.with_suffix('.ans')",
		"    with tempfile.TemporaryDirectory() as folder:",
		"        temporary = pathlib.Path(folder)",
		"        feedback = temporary / 'feedback'",
		"        feedback.mkdir()",
		"        output = temporary / 'output'",
		"        for data, expected in ((answer.read_bytes(), 42), (b'__hydro_invalid_output__\\n', 43)):",
		"            output.write_bytes(data)",
		"            direct = subprocess.run([str(checker), str(input_path), str(output), str(answer)], cwd=validator, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
		"            mapped = {0: 42, 1: 43, 2: 43, 7: 43}.get(direct.returncode, 1)",
		"            if mapped != expected:",
		"                raise RuntimeError(f'{input_path.name}: original Checker returned {direct.returncode}, expected DOMjudge {expected}')",
		"            adapted = subprocess.run([str(run), str(input_path), str(answer), str(feedback)], input=data, cwd=validator, timeout=20)",
		"            if adapted.returncode != mapped:",
		"                raise RuntimeError(f'{input_path.name}: adapter returned {adapted.returncode}, original Checker maps to {mapped}')",
		"checker.write_text('#!/bin/sh\\nexit 3\\n')",
		"checker.chmod(0o755)",
		"with tempfile.TemporaryDirectory() as folder:",
		"    feedback = pathlib.Path(folder)",
		"    answer = input_paths[0].with_suffix('.ans')",
		"    adapted = subprocess.run([str(run), str(input_paths[0]), str(answer), str(feedback)], input=answer.read_bytes(), cwd=validator, timeout=20)",
		"    if adapted.returncode != 1:",
		"        raise RuntimeError(f'adapter returned {adapted.returncode}, expected system error 1')",
		"",
	].join("\n");
	await writeFile(join(directory, "verify.py"), verify);
	await spawnDocker(
		[
			"run",
			"--rm",
			...sandboxRuntimeArgs(),
			"--mount",
			`type=bind,source=${directory},target=/package,readonly`,
			"--workdir",
			"/tmp",
			"--entrypoint",
			"python3",
			image,
			"/package/verify.py",
		],
		Math.max(120_000, caseCount * 45_000),
		signal,
		containerName,
	);
}

export async function writeDomjudgeProblemArchive(
	releaseRoot: string,
	release: ManualRelease,
	image: string,
	options: {
		signal?: AbortSignal;
		containerName?: string;
		taskId?: string;
		pdfPath?: string;
		archivePath?: string;
	} = {},
): Promise<string> {
	if (release.scoringMode !== "acm" || !isContestReadyRelease(release)) {
		throw new Error("只有通过 ACM 完整验证的题目可导出 DOMjudge 包。");
	}
	const target = options.archivePath ?? join(releaseRoot, "domjudge.zip");
	try {
		await stat(target);
		return target;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const project = JSON.parse(await readFile(join(releaseRoot, "source", "project.json"), "utf8")) as ManualProject;
	const interactive = release.judgingMode === "interactive";
	if (interactive !== (project.judgingMode === "interactive")) throw new Error("发布记录与源快照题型不一致。");
	const role = interactive ? "interactor" : "checker";
	const standard = interactive ? (project.interactorStandard ?? "cpp17") : project.checkerStandard;
	const manifest = JSON.parse(await readFile(join(releaseRoot, "source", "manifest.json"), "utf8")) as SourceManifest;
	const problemId = domjudgeProblemId(release.id);
	const stage = await mkdtemp(join(releaseRoot, ".domjudge-"));
	const files = new Map<string, string>();
	try {
		await chmod(stage, 0o777);
		const put = async (name: string, content: string): Promise<void> => {
			const path = join(stage, name);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, content);
			files.set(name, path);
		};
		const memoryMatch = /^(\d+(?:\.\d+)?)(k|m|g|kb|mb|gb)$/iu.exec(project.memoryLimit);
		if (!memoryMatch) throw new Error("已发布题目的内存限制无效。");
		const unit = memoryMatch[2].toLowerCase()[0];
		const memory = Number(memoryMatch[1]) * (unit === "g" ? 1024 : unit === "k" ? 1 / 1024 : 1);
		await put(
			"problem.yaml",
			[
				"problem_format_version: legacy-icpc",
				`name: ${JSON.stringify(release.title)}`,
				interactive ? "validation: custom interactive" : "validation: custom",
				"limits:",
				`  memory: ${Math.ceil(memory)}`,
				"",
			].join("\n"),
		);
		const timeLimitMs = parseHydroTimeLimitMs(project.timeLimit);
		if (timeLimitMs === undefined) throw new Error("已发布题目的时间限制无效。");
		await put("domjudge-problem.ini", `timelimit = ${timeLimitMs / 1000}\nexternalid = ${problemId}\n`);
		const validatorDir = join(stage, "output_validators", role);
		await mkdir(validatorDir, { recursive: true });
		await chmod(validatorDir, 0o777);
		for (const [name, source] of [
			[`${role}.cc`, join(releaseRoot, "source", `${role}.cc`)],
			["testlib.h", join(releaseRoot, "source", "testlib", "testlib.h")],
		] as const) {
			const relative = `output_validators/${role}/${name}`;
			const path = join(stage, relative);
			await copyFile(source, path);
			files.set(relative, path);
		}
		await put(`output_validators/${role}/build`, buildScript(standard, role));
		await put(`output_validators/${role}/run`, interactive ? interactiveRunScript : runScript);
		await chmod(join(validatorDir, "build"), 0o755);
		await chmod(join(validatorDir, "run"), 0o755);
		for (const [index, item] of manifest.cases.entries()) {
			const stem = String(index + 1).padStart(3, "0");
			for (const [extension, name] of [
				["in", item.inputFile],
				["ans", item.outputFile],
			] as const) {
				const relative = `data/secret/${stem}.${extension}`;
				const path = join(stage, relative);
				await mkdir(join(path, ".."), { recursive: true });
				await copyFile(join(releaseRoot, "hydro", release.slug, "testdata", name), path);
				files.set(relative, path);
			}
		}
		for (const [index, sample] of (interactive ? [] : project.samples).entries()) {
			const stem = String(index + 1).padStart(3, "0");
			await put(`data/sample/${stem}.in`, sample.input);
			await put(`data/sample/${stem}.ans`, sample.output);
		}
		if (options.pdfPath || release.domjudgePdf) {
			const path = join(stage, "problem.pdf");
			await copyFile(options.pdfPath ?? join(releaseRoot, "problem.pdf"), path);
			files.set("problem.pdf", path);
		}
		if (interactive) {
			const report = await runInteractiveSandbox(
				{
					mode: "finalize",
					stage: join(stage, "verification"),
					image,
					context: {
						id: options.taskId ?? randomUUID(),
						signal: options.signal ?? new AbortController().signal,
						emit() {},
					},
					reference: project.reference,
					interactor: { language: standard, code: project.interactorSource ?? "" },
					generatorStandard: "cpp17",
					checkerStandard: "cpp17",
					validatorStandard: "cpp17",
					timeLimitMs,
					memoryLimitMb: Math.ceil(memory),
					maxFileBytes: 64 * 1024 * 1024,
					cases: manifest.cases.map((item, index) => ({
						id: String(index + 1),
						inputPath: join(stage, "data", "secret", `${String(index + 1).padStart(3, "0")}.in`),
						outputName: item.outputFile,
					})),
				},
				{
					build: buildScript(standard, role),
					run: interactiveRunScript,
					testlibPath: join(validatorDir, "testlib.h"),
				},
			);
			if (!report.success)
				throw new Error(
					`DOMjudge 交互适配器验证失败：${report.checks
						.filter((item) => !item.passed)
						.map((item) => item.message)
						.join("\n")}`,
				);
		} else await verifyOutputValidator(stage, image, manifest.cases.length, options.signal, options.containerName);
		const temporaryArchive = join(releaseRoot, `.domjudge-${randomUUID()}.zip`);
		try {
			await writeStoredArchiveFromFiles(
				temporaryArchive,
				"",
				files,
				new Map([
					[`output_validators/${role}/build`, 0o755],
					[`output_validators/${role}/run`, 0o755],
				]),
			);
			await rename(temporaryArchive, target);
		} finally {
			await rm(temporaryArchive, { force: true });
		}
		return target;
	} finally {
		await cleanupSandboxStage(stage);
	}
}
