import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { expect, it, vi } from "vitest";
import { ChatService } from "../src/chat.ts";
import { chatPolicy } from "../src/chat-policy.ts";
import { ChatRequestQueue } from "../src/chat-requests.ts";
import { ContestStore } from "../src/contests.ts";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { httpRoute, observeHttp } from "../src/http-observability.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { createObservability, NOOP_OBSERVABILITY } from "../src/observability.ts";
import { TaskQueue } from "../src/tasks.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

it("sends protobuf traces and metrics to an OTLP HTTP receiver, and sends nothing when disabled", async () => {
	const received: Array<{ path: string; type: string | undefined; auth: string | undefined; body: Buffer }> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		received.push({
			path: request.url!,
			type: request.headers["content-type"],
			auth: request.headers.authorization,
			body: Buffer.concat(chunks),
		});
		response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
	});
	const endpoint = await listen(server);
	const environment = {
		SETDRAFT_OTEL_ENABLED: "1",
		OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
		OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20faux-private-key",
		OTEL_TRACES_SAMPLER: "always_on",
	};
	const runtime = createObservability({ environment });
	try {
		const off = createObservability({ environment: { ...environment, SETDRAFT_OTEL_ENABLED: "0" } });
		expect(off).toBe(NOOP_OBSERVABILITY);
		await off.startSpan({ name: "off" }, () => off.metric("setdraft.http.requests", 1));
		await off.flush();
		expect(received).toHaveLength(0);
		await runtime.startSpan(
			{
				name: "transport-proof",
				attributes: {
					"http.route": "/api/projects",
					"chat.content": "PRIVATE_CHAT",
					"http.request.header.cookie": "PRIVATE_COOKIE",
					"db.statement": "PRIVATE_SQL",
				},
			},
			() => {
				runtime.metric("setdraft.http.requests", 1, {
					"http.route": "/api/projects",
					"request.id": "PRIVATE_REQUEST_ID",
					"search.query": "PRIVATE_QUERY",
				});
				runtime.gauge("setdraft.queue.depth", 2, { "queue.kind": "ai" });
			},
		);
		await runtime.flush();
		expect(received.map((item) => item.path).sort()).toEqual(["/v1/metrics", "/v1/traces"]);
		for (const item of received) {
			expect(item.type).toBe("application/x-protobuf");
			expect(item.auth).toBe("Bearer faux-private-key");
			expect(item.body.length).toBeGreaterThan(20);
			expect(item.body.toString()).not.toMatch(/PRIVATE_|faux-private-key/u);
		}
		expect(received.find((item) => item.path === "/v1/traces")?.body.toString()).toContain("transport-proof");
		expect(received.find((item) => item.path === "/v1/metrics")?.body.toString()).toContain("setdraft.http.requests");
	} finally {
		await runtime.shutdown();
		await close(server);
	}
});

it("disables invalid configuration without exposing secrets and tolerates unreachable exporters and failing log sinks", async () => {
	const warn = vi.fn();
	for (const config of [
		{ SETDRAFT_OTEL_ENABLED: "yes" },
		{ SETDRAFT_OTEL_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://secret:private@localhost" },
		{ SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER_ARG: "2" },
		{ SETDRAFT_OTEL_ENABLED: "1", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=private%0Akey" },
		{ SETDRAFT_OTEL_ENABLED: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
	])
		expect(createObservability({ environment: config, warn })).toBe(NOOP_OBSERVABILITY);
	expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret/u);
	const runtime = createObservability({
		environment: {
			SETDRAFT_OTEL_ENABLED: "1",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
			OTEL_TRACES_SAMPLER: "always_on",
		},
		logger: () => {
			throw new Error("sink unavailable");
		},
	});
	try {
		const start = performance.now();
		expect(
			await runtime.startSpan({ name: "business" }, () => {
				runtime.log("business");
				runtime.metric("setdraft.http.requests", 1);
				return "available";
			}),
		).toBe("available");
		expect(performance.now() - start).toBeLessThan(500);
		await runtime.flush();
	} finally {
		await runtime.shutdown();
	}
});

it("ends HTTP and SSE spans on response completion or disconnect, with template labels and correlated logs", async () => {
	const exporter = new InMemorySpanExporter();
	const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const logs: Record<string, unknown>[] = [];
	const runtime = createObservability({
		environment: { SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER: "always_on" },
		spanExporter: exporter,
		metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 }),
		logger: (record) => logs.push(record),
	});
	let end: (() => void) | undefined;
	const server = createServer((request, response) => {
		void observeHttp(runtime, request, response, async () => {
			if (request.url?.includes("events")) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write("data: ready\n\n");
			} else if (request.url?.includes("delay")) {
				response.writeHead(200);
				response.write("ready");
				end = () => response.end("done");
			} else response.end("ok");
		});
	});
	const origin = await listen(server);
	try {
		await fetch(`${origin}/api/health`);
		await fetch(`${origin}/assets/app.js`);
		await fetch(`${origin}/api/system/status`);
		const pending = await fetch(`${origin}/api/projects/delay`);
		await runtime.flush();
		expect(exporter.getFinishedSpans()).toHaveLength(0);
		end?.();
		await pending.text();
		const streaming = await fetch(`${origin}/api/tasks/private-id/events`);
		await streaming.body?.cancel();
		await vi.waitFor(async () => {
			await runtime.flush();
			expect(exporter.getFinishedSpans()).toHaveLength(2);
		});
		const spans = exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "http.sse")).toMatchObject({
			status: { code: SpanStatusCode.ERROR },
			attributes: { "http.route": "/api/tasks/:id/events", "operation.result": "disconnected" },
		});
		expect(logs).toHaveLength(2);
		expect(logs[0]).toMatchObject({
			traceId: expect.any(String),
			spanId: expect.any(String),
			"request.id": expect.any(String),
		});
		for (const batch of metrics.getMetrics())
			for (const scope of batch.scopeMetrics)
				for (const metric of scope.metrics)
					for (const point of metric.dataPoints) {
						expect(point.attributes).not.toHaveProperty("request.id");
						expect(JSON.stringify(point.attributes)).not.toContain("private-id");
					}
		expect(httpRoute("/api/projects/secret/files/private.in")).toBe("/api/projects/:id/files/:id");
		expect(httpRoute("/api/unsupported/private-search-term")).toBe("/api/{unknown}");
	} finally {
		await close(server);
		await runtime.shutdown();
	}
});

it("persists task propagation independently of fingerprints and records queued cancellation, retry and recovery", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-task-telemetry-"));
	const exporter = new InMemorySpanExporter();
	const runtime = createObservability({
		environment: { SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER: "always_on" },
		spanExporter: exporter,
		logger: () => {},
	});
	const projects = new ManualProjectStore({ root, observability: runtime });
	const queues: TaskQueue[] = [];
	try {
		const project = await projects.create("acm");
		const initial = new TaskQueue(projects, new ContestStore(projects));
		queues.push(initial);
		await initial.ready;
		initial.close();
		const task = await runtime.startSpan({ name: "submit-first" }, () => initial.submit("generate", project.id));
		await runtime.flush();
		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["submit-first"]);
		await initial.cancel(task.id);
		const retried = await runtime.startSpan({ name: "submit-retry" }, () => initial.retry(task.id));
		expect(retried.fingerprint).toBe(task.fingerprint);
		const restored = new TaskQueue(projects, new ContestStore(projects));
		queues.push(restored);
		await restored.ready;
		await vi.waitFor(async () => expect((await restored.get(retried.id)).state).toBe("failed"));
		restored.close();
		await restored.idle();
		await runtime.flush();
		const spans = exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "task.queue.end")?.parentSpanContext?.spanId).toBe(
			spans.find((span) => span.name === "submit-first")?.spanContext().spanId,
		);
		expect(spans.find((span) => span.name === "task.execute")?.parentSpanContext?.spanId).toBe(
			spans.find((span) => span.name === "submit-retry")?.spanContext().spanId,
		);
		expect(spans.find((span) => span.name === "task.execute")?.attributes["task.queue_wait"]).toBeGreaterThanOrEqual(
			0,
		);
		const options = await projects.database.get<{ telemetry: { traceparent: string } }>("task-options", retried.id);
		expect(options?.telemetry.traceparent).toContain(
			spans.find((span) => span.name === "submit-retry")?.spanContext().traceId,
		);
	} finally {
		for (const queue of queues) {
			queue.close();
			await queue.idle();
		}
		await runtime.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

it("wraps actual faux AI calls, updates retry parents, measures tokens and ends cancelled attempts", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-ai-telemetry-"));
	const exporter = new InMemorySpanExporter();
	const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const runtime = createObservability({
		environment: { SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER: "always_on" },
		spanExporter: exporter,
		metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 }),
		logger: () => {},
	});
	let attempts = 0;
	const client: ConstructorParameters<typeof ChatService>[0]["client"] = async (request) => {
		expect(request.telemetryContext).toBeDefined();
		request.onDelta?.("PRIVATE_REPLY");
		if (++attempts === 1) throw new Error("PRIVATE_KEY PRIVATE_PROMPT");
		if (attempts === 3)
			await new Promise<void>((_resolve, reject) =>
				request.signal?.addEventListener("abort", () => reject(new DOMException("PRIVATE_KEY", "AbortError")), {
					once: true,
				}),
			);
		return {
			text: "PRIVATE_REPLY",
			usage: {
				input: 12,
				output: 7,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 21,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	};
	const database = new WorkspaceDatabase(root);
	const chat = new ChatService({ root, configPath: join(root, "ai-config.json"), client, observability: runtime });
	await chat.configure({
		provider: "openai-completions",
		modelId: "faux",
		apiKey: "PRIVATE_KEY",
		contextWindow: 8192,
		maxTokens: 1024,
	});
	const policy = chatPolicy({});
	const queue = new ChatRequestQueue(database, chat, {
		scheduler: new ExecutionScheduler(1, policy),
		userId: "test",
		enabled: async () => true,
		observability: runtime,
	});
	try {
		const conversation = await chat.create();
		const id = randomUUID();
		await runtime.startSpan({ name: "ai-submit-first" }, () => queue.submit(conversation.id, id, "PRIVATE_PROMPT"));
		await queue.idle();
		expect((await queue.get(id, conversation.id)).state).toBe("failed");
		const before = await database.sql.one<{ fingerprint: string }>(
			"SELECT fingerprint FROM chat_requests WHERE id=$1",
			[id],
		);
		await runtime.startSpan({ name: "ai-submit-retry" }, () => queue.retry(conversation.id, id));
		await queue.idle();
		expect((await queue.get(id, conversation.id)).state).toBe("done");
		expect(
			(await database.sql.one<{ fingerprint: string }>("SELECT fingerprint FROM chat_requests WHERE id=$1", [id]))
				?.fingerprint,
		).toBe(before?.fingerprint);
		const cancelled = randomUUID();
		await queue.submit(conversation.id, cancelled, "PRIVATE_CANCEL");
		await vi.waitFor(() => expect(attempts).toBe(3));
		await queue.cancel(conversation.id, cancelled);
		await queue.idle();
		await queue.close();
		await database.sql.execute("UPDATE chat_requests SET state='running',cancel_requested=0 WHERE id=$1", [id]);
		const recovered = new ChatRequestQueue(database, chat, {
			scheduler: new ExecutionScheduler(1, policy),
			userId: "test",
			enabled: async () => true,
			observability: runtime,
		});
		try {
			await recovered.ready;
			expect((await recovered.get(id, conversation.id)).state).toBe("failed");
		} finally {
			await recovered.close();
		}
		await runtime.flush();
		const spans = exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "chat.recover")).toMatchObject({
			parentSpanContext: { spanId: spans.find((span) => span.name === "ai-submit-retry")?.spanContext().spanId },
			attributes: { "task.recovered": true, "operation.result": "interrupted" },
		});
		const runs = spans.filter((span) => span.name === "chat.execute");
		expect(runs).toHaveLength(3);
		expect(runs[1].parentSpanContext?.spanId).toBe(
			spans.find((span) => span.name === "ai-submit-retry")?.spanContext().spanId,
		);
		expect(runs[1].attributes["task.attempt"]).toBe(2);
		expect(runs[2].attributes["operation.result"]).toBe("cancelled");
		const calls = spans.filter((span) => span.name === "ai.request");
		expect(calls).toHaveLength(3);
		expect(calls[1].parentSpanContext?.spanId).toBe(runs[1].spanContext().spanId);
		expect(calls[1].attributes["gen_ai.usage.input_tokens"]).toBe(12);
		expect(calls[2].status.code).toBe(SpanStatusCode.ERROR);
		expect(
			JSON.stringify(
				spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
			),
		).not.toContain("PRIVATE_");
		expect(JSON.stringify(metrics.getMetrics())).toContain("setdraft.ai.first_token");
		expect(JSON.stringify(metrics.getMetrics())).toContain("setdraft.ai.tokens");
	} finally {
		await queue.close();
		await runtime.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});

it("honors remote sampling decisions and stops waiting after five seconds during shutdown", async () => {
	const exporter = new InMemorySpanExporter();
	const runtime = createObservability({
		environment: { SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER_ARG: "0" },
		spanExporter: exporter,
	});
	try {
		await runtime.startSpan({ name: "unsampled-root" }, () => {});
		await runtime.withPropagation({ traceparent: "00-11111111111111111111111111111111-2222222222222222-01" }, () =>
			runtime.startSpan({ name: "sampled-child" }, () => {}),
		);
		await runtime.withPropagation({ traceparent: "00-33333333333333333333333333333333-4444444444444444-00" }, () =>
			runtime.startSpan({ name: "unsampled-child" }, () => {}),
		);
		await runtime.flush();
		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["sampled-child"]);
	} finally {
		await runtime.shutdown();
	}
	vi.useFakeTimers();
	try {
		const stuck = createObservability({
			environment: { SETDRAFT_OTEL_ENABLED: "1" },
			spanExporter: { export: (_spans, result) => result({ code: 0 }), shutdown: () => new Promise<void>(() => {}) },
		});
		const closing = stuck.shutdown();
		await vi.advanceTimersByTimeAsync(5000);
		await closing;
		expect(await stuck.startSpan({ name: "after-close" }, () => "available")).toBe("available");
	} finally {
		vi.useRealTimers();
	}
});

it("restores a queued request's parent and keeps concurrent requests isolated", async () => {
	const exporter = new InMemorySpanExporter();
	const runtime = createObservability({
		environment: { SETDRAFT_OTEL_ENABLED: "1", OTEL_TRACES_SAMPLER: "always_on" },
		spanExporter: exporter,
	});
	let queued: ReturnType<typeof runtime.capture>;
	await runtime.startSpan({ name: "submit" }, async () => {
		queued = runtime.capture();
	});
	await Promise.all([
		runtime.withPropagation(queued, () =>
			runtime.startSpan({ name: "execute" }, async () => {
				await Promise.resolve();
				await runtime.startSpan({ name: "sandbox" }, () => "ok");
			}),
		),
		runtime.startSpan({ name: "unrelated" }, () => "ok"),
	]);
	await runtime.flush();
	const spans = exporter.getFinishedSpans();
	const submit = spans.find((span) => span.name === "submit")!;
	const execute = spans.find((span) => span.name === "execute")!;
	expect(execute.parentSpanContext?.spanId).toBe(submit.spanContext().spanId);
	expect(spans.find((span) => span.name === "sandbox")?.parentSpanContext?.spanId).toBe(execute.spanContext().spanId);
	expect(spans.find((span) => span.name === "unrelated")?.spanContext().traceId).not.toBe(
		submit.spanContext().traceId,
	);
	await runtime.shutdown();
});
