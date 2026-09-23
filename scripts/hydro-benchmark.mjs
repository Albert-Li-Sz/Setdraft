import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function option(name) {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
	return process.argv[index + 1];
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function record(root, id) {
	const run = JSON.parse(readFileSync(resolve(root, "run-records", `${id}.json`), "utf8"));
	const started = run.events?.find((event) => event.type === "status" && event.status === "running")?.createdAt ?? run.createdAt;
	const finished = run.events?.findLast((event) => event.type === "status" && ["succeeded", "failed", "needs_input", "cancelled"].includes(event.status))?.createdAt ?? run.updatedAt;
	const elapsedSeconds = (Date.parse(finished) - Date.parse(started)) / 1000;
	if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error(`Invalid run duration: ${id}`);
	return {
		id,
		sourceSha256: createHash("sha256").update(run.source).digest("hex"),
		model: run.model,
		settings: run.modelSettings,
		status: run.status,
		elapsedSeconds,
		modelTurns: run.metrics?.modelTurns,
		toolCalls: run.metrics?.toolCalls ?? run.events?.filter((event) => event.type === "tool" && event.message.startsWith("开始执行 ")).length,
	};
}

const root = option("--workspace");
const baseline = option("--baseline").split(",").map((id) => record(root, id));
const candidate = option("--candidate").split(",").map((id) => record(root, id));
if (baseline.length < 3 || candidate.length < 3)
	throw new Error("Use at least three baseline and three candidate runs to compare medians.");
const sourceSha256 = baseline[0].sourceSha256;
if ([...baseline, ...candidate].some((run) => run.sourceSha256 !== sourceSha256))
	throw new Error("Baseline and candidate runs must use the identical problem source.");
const model = baseline[0].model;
if (!model || [...baseline, ...candidate].some((run) => run.model !== model))
	throw new Error("Baseline and candidate runs must use the same model.");
const knownSettings = [...baseline, ...candidate].map((run) => run.settings).filter(Boolean);
if (knownSettings.length !== baseline.length + candidate.length)
	throw new Error("All compared runs must record contextWindow and maxTokens. Recreate older baselines under the instrumented version.");
const settings = JSON.stringify(knownSettings[0]);
if (knownSettings.some((item) => JSON.stringify(item) !== settings))
	throw new Error("Baseline and candidate runs must use identical context/output limits.");

function summarize(group) {
	return {
		runs: group.length,
		successRate: group.filter((run) => run.status === "succeeded").length / group.length,
		medianSeconds: median(group.map((run) => run.elapsedSeconds)),
		medianModelTurns: group.every((run) => run.modelTurns !== undefined) ? median(group.map((run) => run.modelTurns)) : null,
		medianToolCalls: group.every((run) => run.toolCalls !== undefined) ? median(group.map((run) => run.toolCalls)) : null,
	};
}

const before = summarize(baseline);
const after = summarize(candidate);
const reduction = before.medianSeconds > 0 ? 1 - after.medianSeconds / before.medianSeconds : 0;
process.stdout.write(`${JSON.stringify({ model, sourceSha256, settings: knownSettings[0], baseline: before, candidate: after, medianReductionPercent: Math.round(reduction * 1000) / 10, targetMet: reduction >= 0.5 && after.successRate >= before.successRate }, null, 2)}\n`);
