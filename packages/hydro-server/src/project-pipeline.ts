import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	buildHydroProblemFiles,
	type HydroProblemSpec,
	parseHydroTimeLimitMs,
	validateHydroDirectory,
	validateHydroProblemSpec,
	writeHydroDirectoryArchive,
	writeStoredArchiveFromFiles,
} from "@setdraft/authoring";
import { formatHydroStatement } from "@setdraft/authoring/statement";
import type {
	ManualCaseSummary,
	ManualProject,
	ManualProjectSnapshot,
	ManualRelease,
	ManualSandboxReport,
	ManualVerificationReport,
} from "@setdraft/contracts";
import { verificationContractVersion } from "@setdraft/contracts";
import { effectiveChecker } from "./acm-checker.ts";
import type { ExecutionContext } from "./execution-context.ts";
import type { ManualProjectStore } from "./manual-projects.ts";
import { runManualSandbox, type SandboxCase } from "./manual-sandbox.ts";
import { ManualProjectError } from "./project-error.ts";
import { caseOrder, fileEntries, hashFile, parseGeneratorScript } from "./project-files.ts";
import { copySandboxFile } from "./sandbox-files.ts";
import { sandboxPolicy } from "./sandbox-policy.ts";
import { cleanupSandboxStage } from "./sandbox-runtime.ts";

/** Owns the generation/verification workflow; draft mutations remain in the repository. */
export class ProjectPipeline {
	private readonly projects: ManualProjectStore;
	constructor(projects: ManualProjectStore) {
		this.projects = projects;
	}
	limits(project: ManualProject): { timeLimitMs: number; memoryLimitMb: number } {
		const timeLimitMs = parseHydroTimeLimitMs(project.timeLimit);
		const memory = /^(\d+(?:\.\d+)?)(k|m|g|kb|mb|gb)$/iu.exec(project.memoryLimit);
		const memoryLimitMb = memory
			? Math.ceil(
					Number(memory[1]) *
						(memory[2].toLowerCase().startsWith("g")
							? 1024
							: memory[2].toLowerCase().startsWith("k")
								? 1 / 1024
								: 1),
				)
			: NaN;
		if (
			!timeLimitMs ||
			timeLimitMs < 50 ||
			timeLimitMs > 10_000 ||
			!Number.isSafeInteger(memoryLimitMb) ||
			memoryLimitMb < 32 ||
			memoryLimitMb > 512
		) {
			throw new ManualProjectError("本地沙箱要求时间 50–10000 ms、内存 32–512 MiB。", 422);
		}
		return { timeLimitMs, memoryLimitMb };
	}

	async generate(
		id: string,
		context?: ExecutionContext,
	): Promise<{ project: ManualProjectSnapshot; report: ManualSandboxReport }> {
		const unlock = await this.projects.lock(id, context);
		let stage: string | undefined;
		let imported: string | undefined;

		try {
			const project = await this.projects.load(id);
			if (project.judgingMode === "interactive" && project.interactionInputMode === "empty")
				throw new ManualProjectError("无输入交互题自动使用一个空测试点，无需生成数据。", 422);
			if (project.judgingMode === "interactive" && !project.interactorSource?.trim())
				throw new ManualProjectError("请先添加 C++ testlib 交互器。", 422);
			if (!project.reference.code.trim()) throw new ManualProjectError("请先添加标准程序。", 422);
			if (!project.generatorSource.trim()) throw new ManualProjectError("请上传或填写 Gen 源码。", 422);
			const commands = parseGeneratorScript(project.generatorScript);
			if (commands.length === 0) throw new ManualProjectError("生成脚本没有 gen 命令。", 422);
			const { cases } = await this.projects.caseList(project);
			const manual = cases.filter((item) => item.origin === "manual");
			if (manual.length + commands.length > this.projects.judgeLimits.maxTestCases)
				throw new ManualProjectError("生成后测试点超过评测机上限。", 422);
			const numericMax = Math.max(
				0,
				...manual.filter((item) => /^\d+$/u.test(item.id)).map((item) => Number(item.id)),
			);
			const startNumber = Math.max(manual.length, numericMax) + 1;
			stage = await mkdtemp(join(this.projects.projectDirectory(id), ".generate-"));
			const report = await runManualSandbox({
				mode: "generate",
				context,
				stage,
				image: this.projects.image,
				reference: project.reference,
				interactor:
					project.judgingMode === "interactive"
						? { language: project.interactorStandard ?? "cpp17", code: project.interactorSource ?? "" }
						: undefined,
				oracle: project.oracle,
				generator: project.generatorSource,
				generatorStandard: project.generatorStandard,
				commands,
				startNumber,
				checker: effectiveChecker(project.checkerMode, project.checkerSource),
				checkerStandard: project.checkerStandard,
				validator: project.validatorSource,
				validatorStandard: project.validatorStandard,
				maxFileBytes: this.projects.maxFileBytes,
				...this.limits(project),
			});
			context?.signal.throwIfAborted();
			if (!report.success) return { project: await this.projects.get(id), report };
			imported = await mkdtemp(join(this.projects.projectDirectory(id), ".import-"));
			const budget = { remainingBytes: this.projects.maxProjectBytes };
			for (const [index] of commands.entries()) {
				for (const extension of ["in", "out"]) {
					const name = `${startNumber + index}.${extension}`;
					await copySandboxFile(
						stage,
						`generated/${name}`,
						join(imported, name),
						this.projects.maxFileBytes,
						budget,
						context?.signal,
					);
				}
			}
			const generated = await fileEntries(imported);
			const previousBytes = (await this.projects.database.fileEntries("generated", id)).reduce(
				(sum, file) => sum + file.size,
				0,
			);
			if (
				(await this.projects.projectDataBytes(id)) -
					previousBytes +
					generated.reduce((sum, file) => sum + file.size, 0) >
				this.projects.maxProjectBytes
			)
				throw new ManualProjectError("生成数据超过项目容量上限。", 413);
			project.generatedFromHash = await this.generatedHash(id, project, manual);
			project.revision++;
			project.updatedAt = new Date().toISOString();
			const directory = imported;
			await this.projects.database.commitFiles(
				generated.map((file) => ({
					ownerKind: "generated",
					ownerId: id,
					name: file.name,
					source: { path: join(directory, file.name) },
				})),
				async () => await this.projects.save(project, context),
				[{ ownerKind: "generated", ownerId: id }],
			);
			return { project: await this.projects.snapshot(id), report };
		} finally {
			unlock();
			if (stage) await cleanupSandboxStage(stage);
			if (imported) await cleanupSandboxStage(imported);
		}
	}

	private async projectHash(project: ManualProject, cases: ManualCaseSummary[]): Promise<string> {
		const hash = createHash("sha256").update(
			JSON.stringify({
				slug: project.slug,
				scoringMode: project.scoringMode,
				judgingMode: project.judgingMode ?? "default",
				interactionInputMode: project.interactionInputMode ?? "provided",
				interactorSource: project.interactorSource ?? "",
				interactorStandard: project.interactorStandard ?? "cpp17",
				title: project.title,
				tags: project.tags,
				statement: project.statement,
				statementSections: project.statementSections,
				samples: project.samples,
				timeLimit: project.timeLimit,
				memoryLimit: project.memoryLimit,
				reference: project.reference,
				oracle: project.oracle,
				generatorSource: project.generatorSource,
				solutions: project.solutions,
				referenceSolutionId: project.referenceSolutionId,
				generatorStandard: project.generatorStandard,
				generatorScript: project.generatorScript,
				checkerSource: project.checkerSource,
				checkerMode: project.checkerMode,
				checkerStandard: project.checkerStandard,
				validatorSource: project.validatorSource,
				validatorStandard: project.validatorStandard,
				subtasks: project.subtasks,
				caseSubtasks: project.caseSubtasks,
				attachments: project.attachments,
				domjudgePdf: project.domjudgePdf,
			}),
		);
		for (const item of cases) {
			hash
				.update(item.origin)
				.update(item.inputFile)
				.update(await hashFile(await this.projects.dataFile(project.id, item.origin, item.inputFile)));
			if (item.outputFile)
				hash
					.update(item.outputFile)
					.update(await hashFile(await this.projects.dataFile(project.id, item.origin, item.outputFile)));
		}
		return hash.digest("hex");
	}

	private async generatedHash(id: string, project: ManualProject, manualCases: ManualCaseSummary[]): Promise<string> {
		const inputs = await Promise.all(
			manualCases
				.slice()
				.sort(caseOrder)
				.map(async (item) => ({
					origin: item.origin,
					name: item.inputFile,
					hash: await hashFile(await this.projects.dataFile(id, item.origin, item.inputFile)),
				})),
		);
		return createHash("sha256")
			.update(
				JSON.stringify([
					project.generatorSource,
					project.generatorStandard,
					project.generatorScript,
					project.reference,
					inputs,
					...(project.judgingMode === "interactive"
						? [project.judgingMode, project.interactorSource, project.interactorStandard]
						: []),
				]),
			)
			.digest("hex");
	}

	private spec(project: ManualProject, cases: ManualCaseSummary[]): HydroProblemSpec {
		const interactive = project.judgingMode === "interactive";
		const emptyInput = interactive && project.interactionInputMode === "empty";
		return {
			type: interactive ? "interactive" : "default",
			...(interactive
				? {
						interactor: project.interactorSource,
						interactorLanguage: "auto",
					}
				: {}),
			slug: project.slug,
			title: project.title,
			tags: project.tags,
			language: "zh",
			statement: formatHydroStatement(project),
			timeLimit: project.timeLimit,
			memoryLimit: project.memoryLimit,
			checker: interactive
				? undefined
				: { type: "testlib", source: effectiveChecker(project.checkerMode, project.checkerSource) ?? "" },
			attachments: project.attachments.map((item) => ({
				name: item.name,
				content: Buffer.from(item.contentBase64, "base64"),
			})),
			subtasks: (emptyInput ? [{ id: 1, type: "min" as const, score: 100 }] : project.subtasks).map((subtask) => ({
				...subtask,
				cases: cases
					.filter((item) => item.subtaskId === subtask.id)
					.map((item) => ({
						inputFile: item.inputFile,
						input: "",
						outputFile: item.outputFile ?? `${item.id}.out`,
						output: "",
					})),
			})),
		};
	}

	async finalize(
		id: string,
		context?: ExecutionContext,
		name?: string,
	): Promise<{ release?: ManualRelease; report: ManualVerificationReport }> {
		const unlock = await this.projects.lock(id, context);
		let stage: string | undefined;
		let releaseDirectory: string | undefined;
		let releaseId: string | undefined;
		try {
			const project = await this.projects.load(id);
			const interactive = project.judgingMode === "interactive";
			const emptyInput = interactive && project.interactionInputMode === "empty";
			if (!project.reference.code.trim()) throw new ManualProjectError("标准程序是打包前的必填项。", 422);
			if (interactive && !project.interactorSource?.trim())
				throw new ManualProjectError("请提供 C++ testlib 交互器源码。", 422);
			if (!interactive && !effectiveChecker(project.checkerMode, project.checkerSource)) {
				throw new ManualProjectError("请选择文本比对 Checker，或提供 C++ testlib Checker 源码。", 422);
			}
			if (
				!emptyInput &&
				project.scoringMode === "acm" &&
				(project.subtasks.length !== 1 ||
					project.subtasks[0].id !== 1 ||
					project.subtasks[0].type !== "min" ||
					project.subtasks[0].score !== 100)
			) {
				throw new ManualProjectError("ACM 题目仅允许一个 100 分 min 分组。", 422);
			}
			const { cases: storedCases, orphanOutputs } = await this.projects.caseList(project);
			const cases: ManualCaseSummary[] = emptyInput
				? [
						{
							id: "interactive-empty",
							origin: "manual",
							inputFile: "interactive-empty.in",
							outputFile: "interactive-empty.out",
							inputBytes: 0,
							outputBytes: 0,
							subtaskId: 1,
						},
					]
				: storedCases.map((item) =>
						interactive ? { ...item, outputFile: `${item.id}.out`, outputBytes: 0 } : item,
					);
			if (!interactive && orphanOutputs.length)
				throw new ManualProjectError(`存在没有对应 .in 的输出文件：${orphanOutputs.join(", ")}`, 422);
			if (cases.length === 0) throw new ManualProjectError("请先上传测试数据或运行 Gen。", 422);
			if (project.scoringMode === "acm" && cases.some((item) => item.subtaskId !== 1)) {
				throw new ManualProjectError("ACM 题目的所有测试点必须位于唯一分组。", 422);
			}
			if (cases.some((item) => item.origin === "generated")) {
				if (
					project.generatedFromHash !==
					(await this.generatedHash(
						id,
						project,
						cases.filter((item) => item.origin === "manual"),
					))
				) {
					throw new ManualProjectError("Gen、脚本、标程或手动测试点编号已修改，请重新生成数据。", 422);
				}
				const names = new Set<string>();
				for (const item of cases) {
					for (const name of [item.inputFile, item.outputFile ?? `${item.id}.out`]) {
						if (names.has(name)) throw new ManualProjectError(`测试文件 ${name} 重名，请重新生成数据。`, 422);
						names.add(name);
					}
				}
			}
			const spec = this.spec(project, cases);
			const structural = validateHydroProblemSpec(spec, this.projects.judgeLimits);
			if (!structural.valid)
				throw new ManualProjectError(
					structural.issues.map((item) => `${item.path}: ${item.message}`).join("\n"),
					422,
				);
			stage = await mkdtemp(join(this.projects.projectDirectory(id), ".verify-"));
			if (emptyInput) await writeFile(join(stage, "interactive-empty.in"), "");
			const sandboxCases: SandboxCase[] = await Promise.all(
				cases.map(async (item) => ({
					id: item.id,
					inputPath: emptyInput
						? join(stage!, "interactive-empty.in")
						: await this.projects.dataFile(id, item.origin, item.inputFile),
					outputPath:
						!interactive && item.outputFile
							? await this.projects.dataFile(id, item.origin, item.outputFile)
							: undefined,
					outputName: item.outputFile ?? `${item.id}.out`,
				})),
			);
			const sandbox = await runManualSandbox({
				mode: "finalize",
				context,
				stage,
				image: this.projects.image,
				reference: project.reference,
				interactor: interactive
					? { language: project.interactorStandard ?? "cpp17", code: project.interactorSource ?? "" }
					: undefined,
				oracle: project.oracle,
				generatorStandard: project.generatorStandard,
				checker: effectiveChecker(project.checkerMode, project.checkerSource),
				checkerStandard: project.checkerStandard,
				validator: emptyInput ? undefined : project.validatorSource,
				validatorStandard: project.validatorStandard,
				cases: sandboxCases,
				samples: project.samples,
				maxFileBytes: this.projects.maxFileBytes,
				...this.limits(project),
			});
			context?.signal.throwIfAborted();
			const report: ManualVerificationReport = {
				...sandbox,
				verificationContractVersion,
				revision: project.revision,
				projectHash: await this.projectHash(project, storedCases),
				issues: structural.issues,
				verifiedAt: new Date().toISOString(),
			};
			if (report.success) {
				const run = await this.projects.runs.required(project, context);
				report.matrixRunId = run.id;
				for (const result of run.matrix?.solutions ?? [])
					report.checks.push({
						stage: "solution-expectation",
						passed: result.matches,
						message: `${run.solutions.find((item) => item.id === result.solutionId)?.name}: ${result.message}`,
						score: result.score,
					});
				report.success = run.state === "complete" && run.matrix?.requiredPassed === true;
			}
			project.lastReport = report;
			await this.projects.save(project, context);
			if (!report.success) return { report };

			releaseId = randomUUID();
			releaseDirectory = this.projects.releaseDirectory(releaseId);
			await mkdir(join(releaseDirectory, "hydro", project.slug), { recursive: true });
			const hydroRoot = join(releaseDirectory, "hydro", project.slug);
			for (const [name, content] of buildHydroProblemFiles(spec, this.projects.judgeLimits)) {
				const path = join(hydroRoot, name);
				await mkdir(join(path, ".."), { recursive: true });
				await writeFile(path, content);
			}
			const outputBudget = { remainingBytes: this.projects.maxProjectBytes };
			for (const item of cases) {
				await copyFile(
					emptyInput
						? join(stage, "interactive-empty.in")
						: await this.projects.dataFile(id, item.origin, item.inputFile),
					join(hydroRoot, "testdata", item.inputFile),
				);
				await copySandboxFile(
					stage,
					`verified/${item.outputFile ?? `${item.id}.out`}`,
					join(hydroRoot, "testdata", item.outputFile ?? `${item.id}.out`),
					this.projects.maxFileBytes,
					outputBudget,
					context?.signal,
				);
			}
			const directoryReport = await validateHydroDirectory(hydroRoot, { judgeLimits: this.projects.judgeLimits });
			if (!directoryReport.valid)
				throw new ManualProjectError(directoryReport.issues.map((item) => item.message).join("\n"), 422);
			const hydroArchive = join(releaseDirectory, "hydro.zip");
			await (context?.observability ?? this.projects.observability).startSpan(
				{ name: "release.export", attributes: { "export.format": "hydro", "project.id": id } },
				() =>
					writeHydroDirectoryArchive(hydroRoot, hydroArchive, {
						judgeLimits: this.projects.judgeLimits,
					}),
			);

			const sourceRoot = join(releaseDirectory, "source");
			await mkdir(sourceRoot, { recursive: true });
			const sourceFiles = new Map<string, string>();
			const sourceTexts: Record<string, string> = {
				"project.json": JSON.stringify(project, null, 2),
				"report.json": JSON.stringify(report, null, 2),
				"reference.txt": project.reference.code,
				"generator.cc": project.generatorSource,
				"generate.txt": project.generatorScript,
				"checker.cc": effectiveChecker(project.checkerMode, project.checkerSource) ?? "",
				"validator.cc": project.validatorSource,
				"oracle.txt": project.oracle?.code ?? "",
				...(interactive ? { "interactor.cc": project.interactorSource ?? "" } : {}),
			};
			for (const [name, content] of Object.entries(sourceTexts)) {
				const path = join(sourceRoot, name);
				await writeFile(path, content);
				sourceFiles.set(name, path);
			}
			if (project.domjudgePdf) {
				const pdfSource =
					(await this.projects.database.filePath("pdf", id, "problem.pdf")) ??
					join(this.projects.projectDirectory(id), "domjudge", "problem.pdf");
				if ((await hashFile(pdfSource)) !== project.domjudgePdf.sha256) {
					throw new ManualProjectError("DOMjudge PDF 已在项目目录外被修改，请重新上传。", 422);
				}
				await copyFile(pdfSource, join(releaseDirectory, "problem.pdf"));
				const sourceTarget = join(sourceRoot, "problem.pdf");
				await copyFile(pdfSource, sourceTarget);
				sourceFiles.set("problem.pdf", sourceTarget);
			}
			for (const origin of ["manual", "generated"] as const) {
				for (const file of await this.projects.database.fileEntries(origin, id)) {
					const relative = `data/${origin}/${file.name}`;
					const target = join(sourceRoot, relative);
					await mkdir(join(target, ".."), { recursive: true });
					await copyFile(await this.projects.dataFile(id, origin, file.name), target);
					sourceFiles.set(relative, target);
				}
			}
			if (emptyInput) {
				const relative = "data/automatic/interactive-empty.in";
				const target = join(sourceRoot, relative);
				await mkdir(join(target, ".."), { recursive: true });
				await writeFile(target, "");
				sourceFiles.set(relative, target);
			}
			for (const item of cases) {
				const verifiedName = item.outputFile ?? `${item.id}.out`;
				const verifiedRelative = `data/verified/${verifiedName}`;
				const verifiedTarget = join(sourceRoot, verifiedRelative);
				await mkdir(join(verifiedTarget, ".."), { recursive: true });
				await copyFile(join(hydroRoot, "testdata", verifiedName), verifiedTarget);
				sourceFiles.set(verifiedRelative, verifiedTarget);
			}
			for (const name of ["testlib.h", "LICENSE"]) {
				const source = fileURLToPath(new URL(`../sandbox/testlib/${name}`, import.meta.url));
				const relative = `testlib/${name}`;
				const target = join(sourceRoot, relative);
				await mkdir(join(target, ".."), { recursive: true });
				await copyFile(source, target);
				sourceFiles.set(relative, target);
			}
			const logBudget = { remainingBytes: 64 * 1024 * 1024 };
			const logPaths = new Set(report.checks.flatMap((check) => (check.logPath ? [check.logPath] : [])));
			if (interactive) {
				for (const item of cases)
					for (const role of project.oracle ? ["reference", "oracle"] : ["reference"])
						logPaths.add(`logs/${role}-${item.id}.json`);
			}
			for (const relative of logPaths) {
				if (!/^logs\/[A-Za-z0-9._-]+$/u.test(relative)) throw new Error("沙箱日志路径无效。");
				const target = join(sourceRoot, relative);
				await mkdir(join(target, ".."), { recursive: true });
				await copySandboxFile(stage, relative, target, this.projects.maxFileBytes, logBudget, context?.signal);
				sourceFiles.set(relative, target);
			}
			const fileHashes = Object.fromEntries(
				await Promise.all([...sourceFiles].map(async ([name, path]) => [name, await hashFile(path)] as const)),
			);
			const manifest = {
				projectId: id,
				revision: project.revision,
				projectHash: report.projectHash,
				sandboxImage: this.projects.image,
				imageDigest: (
					await promisify(execFile)("docker", ["image", "inspect", "--format", "{{.Id}}", this.projects.image])
				).stdout.trim(),
				toolchain: report.toolchain,
				environment: {
					locale: "C.UTF-8",
					timezone: "UTC",
					network: "none",
					cpus: sandboxPolicy().cpus,
					memory: `${sandboxPolicy().memoryMb}m`,
					readOnly: true,
				},
				languages: {
					reference: project.reference.language,
					oracle: project.oracle?.language,
					generator: project.generatorStandard,
					checker: project.checkerStandard,
					validator: project.validatorStandard,
					...(interactive ? { interactor: project.interactorStandard ?? "cpp17" } : {}),
				},
				testlibCommit: "1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd",
				testlibSha256: fileHashes["testlib/testlib.h"],
				generatorCommands:
					!emptyInput && project.generatorScript.trim() ? parseGeneratorScript(project.generatorScript) : [],
				cases: cases.map((item) => ({
					id: item.id,
					origin: emptyInput ? "automatic" : item.origin,
					inputFile: item.inputFile,
					outputFile: item.outputFile ?? `${item.id}.out`,
					subtaskId: item.subtaskId,
				})),
				files: fileHashes,
			};
			const manifestPath = join(sourceRoot, "manifest.json");
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			sourceFiles.set("manifest.json", manifestPath);
			await writeStoredArchiveFromFiles(
				join(releaseDirectory, "source.zip"),
				`${project.slug}.authoring`,
				sourceFiles,
			);
			const release: ManualRelease = {
				name: name ?? `v${project.revision}`,
				id: releaseId,
				scoringMode: project.scoringMode,
				judgingMode: project.judgingMode ?? "default",
				interactionInputMode: project.interactionInputMode ?? "provided",
				projectId: id,
				revision: project.revision,
				projectHash: report.projectHash,
				slug: project.slug,
				title: project.title,
				createdAt: new Date().toISOString(),
				report,
				checkerMode: project.checkerMode,
				domjudgePdf: Boolean(project.domjudgePdf),
			};
			const files = ["hydro.zip", "source.zip", ...(project.domjudgePdf ? ["problem.pdf"] : [])].map((name) => ({
				ownerKind: "release-file",
				ownerId: release.id,
				name,
				source: { path: join(releaseDirectory!, name) },
			}));
			project.latestReleaseId = releaseId;
			await this.projects.database.commitFiles(files, async () => {
				context?.signal.throwIfAborted();
				await this.projects.database.put("release", release.id, release);
				await this.projects.save(project, context);
			});
			releaseDirectory = undefined;
			return { release, report };
		} finally {
			unlock();
			if (stage) await cleanupSandboxStage(stage);
			if (releaseDirectory) {
				if (releaseId) {
					await this.projects.database.delete("release", releaseId);
					await this.projects.database.removeOwnerFiles("release-file", releaseId);
				}
				await rm(releaseDirectory, { recursive: true, force: true });
			}
		}
	}
}
