import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHydroTimeLimitMs, writeStoredArchiveFromFiles } from "@hydro-problem-make/authoring";
import type { ManualProject, ManualRelease } from "./manual-projects.ts";
import type { CppLanguage } from "./manual-sandbox.ts";

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

function buildScript(standard: CppLanguage): string {
	return [
		"#!/bin/sh",
		"set -eu",
		'cd "$(dirname "$0")"',
		`g++ -std=${standardNames[standard]} -O2 -pipe -I. checker.cc -o checker`,
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

function spawnDocker(args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		const errors: Buffer[] = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stderr.on("data", (chunk: Buffer) => {
			if (errors.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) errors.push(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new Error(Buffer.concat(errors).toString("utf8").slice(0, 4000) || `DOMjudge Checker 验证失败：${code}`),
				);
		});
	});
}

async function verifyOutputValidator(directory: string, image: string, caseCount: number): Promise<void> {
	const verify = [
		"import pathlib, subprocess, tempfile",
		"root = pathlib.Path('/work')",
		"validator = root / 'output_validators' / 'checker'",
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
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--user",
			"65534:65534",
			"--tmpfs",
			"/tmp:rw,exec,size=128m,mode=1777",
			"--mount",
			`type=bind,source=${directory},target=/work`,
			"--workdir",
			"/work",
			"--entrypoint",
			"python3",
			image,
			"/work/verify.py",
		],
		Math.max(120_000, caseCount * 45_000),
	);
}

export async function writeDomjudgeProblemArchive(
	releaseRoot: string,
	release: ManualRelease,
	image: string,
): Promise<string> {
	if (
		release.scoringMode !== "acm" ||
		!release.report.success ||
		!release.report.checkerUsed ||
		!release.checkerMode
	) {
		throw new Error("只有通过 ACM Checker 验证的题目可导出 DOMjudge 包。");
	}
	const target = join(releaseRoot, "domjudge.zip");
	try {
		await stat(target);
		return target;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const project = JSON.parse(await readFile(join(releaseRoot, "source", "project.json"), "utf8")) as ManualProject;
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
				"validation: custom",
				"limits:",
				`  memory: ${Math.ceil(memory)}`,
				"",
			].join("\n"),
		);
		const timeLimitMs = parseHydroTimeLimitMs(project.timeLimit);
		if (timeLimitMs === undefined) throw new Error("已发布题目的时间限制无效。");
		await put("domjudge-problem.ini", `timelimit = ${timeLimitMs / 1000}\nexternalid = ${problemId}\n`);
		const validatorDir = join(stage, "output_validators", "checker");
		await mkdir(validatorDir, { recursive: true });
		await chmod(validatorDir, 0o777);
		for (const [name, source] of [
			["checker.cc", join(releaseRoot, "source", "checker.cc")],
			["testlib.h", join(releaseRoot, "source", "testlib", "testlib.h")],
		] as const) {
			const relative = `output_validators/checker/${name}`;
			const path = join(stage, relative);
			await copyFile(source, path);
			files.set(relative, path);
		}
		await put("output_validators/checker/build", buildScript(project.checkerStandard));
		await put("output_validators/checker/run", runScript);
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
		for (const [index, sample] of project.samples.entries()) {
			const stem = String(index + 1).padStart(3, "0");
			await put(`data/sample/${stem}.in`, sample.input);
			await put(`data/sample/${stem}.ans`, sample.output);
		}
		if (release.domjudgePdf) {
			const path = join(stage, "problem.pdf");
			await copyFile(join(releaseRoot, "problem.pdf"), path);
			files.set("problem.pdf", path);
		}
		await verifyOutputValidator(stage, image, manifest.cases.length);
		const temporaryArchive = join(releaseRoot, `.domjudge-${randomUUID()}.zip`);
		try {
			await writeStoredArchiveFromFiles(
				temporaryArchive,
				"",
				files,
				new Map([
					["output_validators/checker/build", 0o755],
					["output_validators/checker/run", 0o755],
				]),
			);
			await rename(temporaryArchive, target);
		} finally {
			await rm(temporaryArchive, { force: true });
		}
		return target;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}
