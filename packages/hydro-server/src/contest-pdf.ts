import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContestPdfDocument } from "./contest-pdf-document.ts";
import { NOOP_OBSERVABILITY, type Observability, secondsSince } from "./observability.ts";
import { ManualProjectError } from "./project-error.ts";

let activeCompilers = 0;

export async function compileContestPdfs(
	root: string,
	document: ContestPdfDocument,
	signal?: AbortSignal,
	bookletOnly = false,
	observability: Observability = NOOP_OBSERVABILITY,
) {
	return observability.startSpan({ name: "pdf.compile" }, async (span) => {
		const start = performance.now();
		let result = "error";
		try {
			const pdfs = await compile(root, document, signal, bookletOnly);
			result = "ok";
			return pdfs;
		} finally {
			if (signal?.aborted) result = "cancelled";
			span.setAttributes({ "operation.result": result });
			observability.metric("setdraft.pdf.duration", secondsSince(start), { "operation.result": result });
		}
	});
}

async function compile(root: string, document: ContestPdfDocument, signal?: AbortSignal, bookletOnly = false) {
	signal?.throwIfAborted();
	if (activeCompilers >= 2) throw new ManualProjectError("PDF 生成繁忙，请稍后重试。", 429);
	const labels = document.problems.map((problem) => problem.label);
	if (
		labels.length < 1 ||
		labels.length > 100 ||
		new Set(labels).size !== labels.length ||
		labels.some((label) => !/^[A-Z]{1,3}$/u.test(label))
	)
		throw new ManualProjectError("PDF 必须包含 1–100 道题，题号须为不重复的 1–3 位大写字母。", 422);
	const serialized = JSON.stringify({ document, bookletOnly });
	if (Buffer.byteLength(serialized) > 20 * 1024 * 1024)
		throw new ManualProjectError("PDF 题面与附件合计不能超过 20 MiB。", 422);
	activeCompilers++;
	let directory: string | undefined;
	try {
		await mkdir(root, { recursive: true });
		directory = await mkdtemp(join(root, ".pdf-"));
		await writeFile(join(directory, "job.json"), serialized);
		signal?.throwIfAborted();
		const worker = new URL(
			import.meta.url.endsWith(".ts") ? "./contest-pdf-worker.ts" : "./contest-pdf-worker.js",
			import.meta.url,
		);
		const runtimeArgs = import.meta.url.endsWith(".ts") ? ["--import", "tsx", "--conditions=source"] : [];
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				["--max-old-space-size=384", ...runtimeArgs, fileURLToPath(worker), directory!],
				{
					stdio: ["ignore", "ignore", "pipe"],
					env: {
						PATH: process.env.PATH,
						LANG: "C.UTF-8",
					},
				},
			);
			let failure: Error | undefined;
			let diagnostic = "";
			const stop = (error: Error) => {
				failure = error;
				child.kill("SIGKILL");
			};
			const abort = () => stop(new Error("PDF 生成已取消。"));
			const timer = setTimeout(() => stop(new Error("PDF 生成超时，请缩减题面内容。")), 90_000);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.stderr.on("data", (chunk: Buffer) => {
				diagnostic = (diagnostic + chunk.toString("utf8")).slice(0, 6000);
			});
			child.once("error", (error) => {
				failure = error;
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (failure || code !== 0) reject(failure ?? new Error(diagnostic || `PDF 编译进程退出：${code}`));
				else resolve();
			});
		});
		const finished = directory;
		directory = undefined;
		return {
			booklet: join(finished, "booklet.pdf"),
			problems: new Map((bookletOnly ? [] : labels).map((label) => [label, join(finished, `${label}.pdf`)])),
			cleanup: async () => await rm(finished, { recursive: true, force: true }),
		};
	} catch (error) {
		if (error instanceof ManualProjectError) throw error;
		throw new ManualProjectError(error instanceof Error ? error.message : "PDF 生成失败。", 422);
	} finally {
		try {
			if (directory) await rm(directory, { recursive: true, force: true });
		} finally {
			activeCompilers--;
		}
	}
}
