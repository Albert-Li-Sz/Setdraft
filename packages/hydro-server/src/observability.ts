import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanAttributes, SpanOptions, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { type Attributes, type Context, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, type MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
	AlwaysOffSampler,
	AlwaysOnSampler,
	BatchSpanProcessor,
	ParentBasedSampler,
	type Sampler,
	type SpanExporter,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/** Only W3C trace context is persisted. Baggage and arbitrary headers are never propagated. */
export interface TraceCarrier {
	traceparent: string;
	tracestate?: string;
}

const instruments = {
	"setdraft.http.requests": "counter",
	"setdraft.http.duration": "histogram",
	"setdraft.queue.wait": "histogram",
	"setdraft.task.duration": "histogram",
	"setdraft.task.results": "counter",
	"setdraft.pdf.duration": "histogram",
	"setdraft.ai.duration": "histogram",
	"setdraft.ai.first_token": "histogram",
	"setdraft.ai.tokens": "counter",
	"setdraft.search.duration": "histogram",
} as const;
type MetricName = keyof typeof instruments;
type GaugeName = "setdraft.queue.depth" | "setdraft.queue.running";

export interface Observability extends TelemetryContext {
	readonly enabled: boolean;
	capture(): TraceCarrier | undefined;
	withPropagation<T>(carrier: TraceCarrier | undefined, work: () => T): T;
	metric(name: MetricName, value: number, attributes?: SpanAttributes): void;
	gauge(name: GaugeName, value: number, attributes?: SpanAttributes): void;
	log(event: string, attributes?: SpanAttributes): void;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

export const NOOP_OBSERVABILITY: Observability = Object.freeze({
	...NOOP_TELEMETRY_CONTEXT,
	enabled: false,
	capture: () => undefined,
	withPropagation: <T>(_carrier: TraceCarrier | undefined, work: () => T): T => work(),
	metric: () => {},
	gauge: () => {},
	log: () => {},
	flush: async () => {},
	shutdown: async () => {},
});

const metricAttributes = new Set([
	"http.request.method",
	"http.route",
	"http.response.status_code",
	"http.transport",
	"task.kind",
	"task.state",
	"queue.kind",
	"gen_ai.system",
	"operation.result",
	"token.type",
	"export.format",
]);
const allowedAttributes = new Set([
	...metricAttributes,
	"request.id",
	"task.id",
	"project.id",
	"chat.request.id",
	"task.attempt",
	"task.queue_wait",
	"task.recovered",
	"error.type",
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.output_tokens",
	"gen_ai.usage.cache_read_tokens",
	"gen_ai.usage.cache_write_tokens",
]);
function attributes(input: SpanAttributes = {}, metrics = false): Attributes {
	const result: Attributes = {};
	for (const [key, value] of Object.entries(input)) {
		if (!(metrics ? metricAttributes : allowedAttributes).has(key)) continue;
		if (typeof value === "string") result[key] = value.slice(0, 160);
		else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
	}
	return result;
}

export function errorCategory(error: unknown): string {
	const names = new Set([
		"AbortError",
		"TimeoutError",
		"ChatError",
		"ManualProjectError",
		"AuthError",
		"QueueAdmissionError",
		"SandboxCleanupError",
	]);
	return error instanceof Error && names.has(error.name) ? error.name : "Error";
}
export function secondsSince(start: number): number {
	return Math.max(0, (performance.now() - start) / 1000);
}
export function traceCarrier(value: unknown): TraceCarrier | undefined {
	if (!value || typeof value !== "object" || !("traceparent" in value)) return undefined;
	const parent = value.traceparent;
	if (typeof parent !== "string" || !/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/u.test(parent)) return undefined;
	const state = "tracestate" in value ? value.tracestate : undefined;
	return {
		traceparent: parent,
		...(typeof state === "string" && state.length <= 512 && !/[\r\n]/u.test(state) ? { tracestate: state } : {}),
	};
}

function sampler(environment: NodeJS.ProcessEnv): Sampler {
	const ratio = Number(environment.OTEL_TRACES_SAMPLER_ARG ?? "0.1");
	if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("Invalid sampler ratio");
	switch (environment.OTEL_TRACES_SAMPLER ?? "parentbased_traceidratio") {
		case "always_on":
			return new AlwaysOnSampler();
		case "always_off":
			return new AlwaysOffSampler();
		case "traceidratio":
			return new TraceIdRatioBasedSampler(ratio);
		case "parentbased_always_on":
			return new ParentBasedSampler({ root: new AlwaysOnSampler() });
		case "parentbased_always_off":
			return new ParentBasedSampler({ root: new AlwaysOffSampler() });
		case "parentbased_traceidratio":
			return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
		default:
			throw new Error("Unsupported sampler");
	}
}
function endpoint(value: string | undefined, signal: "traces" | "metrics", specific: boolean): string {
	const url = new URL(value ?? "http://localhost:4318");
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("Invalid endpoint");
	if (!specific) url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/${signal}`;
	return url.toString();
}
function headers(value: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of value?.split(",") ?? []) {
		const separator = entry.indexOf("=");
		if (separator < 1) throw new Error("Invalid headers");
		const key = entry.slice(0, separator).trim();
		const content = decodeURIComponent(entry.slice(separator + 1).trim());
		if (!/^[A-Za-z0-9_-]+$/u.test(key) || /[\r\n]/u.test(content)) throw new Error("Invalid headers");
		result[key] = content;
	}
	return result;
}

export interface ObservabilityOptions {
	environment?: NodeJS.ProcessEnv;
	spanExporter?: SpanExporter;
	metricReader?: MetricReader;
	warn?(message: string): void;
	logger?(record: Record<string, unknown>): void;
}

/** Explicit providers and per-instance async context avoid process-global SDK state and cross-request leakage. */
export function createObservability(options: ObservabilityOptions = {}): Observability {
	const environment = options.environment ?? process.env;
	if ((environment.SETDRAFT_OTEL_ENABLED ?? "0") === "0") return NOOP_OBSERVABILITY;
	try {
		if (environment.SETDRAFT_OTEL_ENABLED !== "1") throw new Error("Invalid enable flag");
		for (const key of [
			"OTEL_EXPORTER_OTLP_PROTOCOL",
			"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
			"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
		])
			if (environment[key] && environment[key] !== "http/protobuf") throw new Error("Unsupported protocol");
		const service = environment.OTEL_SERVICE_NAME ?? "setdraft";
		if (!service.trim() || service.length > 120 || /[\r\n]/u.test(service)) throw new Error("Invalid service name");
		const resource = resourceFromAttributes({ "service.name": service });
		const selectedSampler = sampler(environment);
		const traceUrl = endpoint(
			environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? environment.OTEL_EXPORTER_OTLP_ENDPOINT,
			"traces",
			!!environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
		);
		const metricUrl = endpoint(
			environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? environment.OTEL_EXPORTER_OTLP_ENDPOINT,
			"metrics",
			!!environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
		);
		const commonHeaders = headers(environment.OTEL_EXPORTER_OTLP_HEADERS);
		const traceHeaders = { ...commonHeaders, ...headers(environment.OTEL_EXPORTER_OTLP_TRACES_HEADERS) };
		const metricHeaders = { ...commonHeaders, ...headers(environment.OTEL_EXPORTER_OTLP_METRICS_HEADERS) };
		const provider = new NodeTracerProvider({
			resource,
			sampler: selectedSampler,
			spanProcessors: [
				new BatchSpanProcessor(
					options.spanExporter ??
						new OTLPTraceExporter({
							url: traceUrl,
							headers: traceHeaders,
							timeoutMillis: 2000,
							concurrencyLimit: 1,
						}),
					{ maxQueueSize: 2048, maxExportBatchSize: 256, scheduledDelayMillis: 1000, exportTimeoutMillis: 2500 },
				),
			],
		});
		const reader =
			options.metricReader ??
			(options.spanExporter
				? undefined
				: new PeriodicExportingMetricReader({
						exporter: new OTLPMetricExporter({
							url: metricUrl,
							headers: metricHeaders,
							timeoutMillis: 2000,
							concurrencyLimit: 1,
						}),
						exportIntervalMillis: 60_000,
						exportTimeoutMillis: 2500,
					}));
		const meters = new MeterProvider({ resource, readers: reader ? [reader] : [] });
		const meter = meters.getMeter("setdraft");
		const values = new Map<GaugeName, Map<string, { value: number; labels: Attributes }>>();
		const metrics = new Map(
			Object.entries(instruments).map(([name, type]) => [
				name,
				type === "counter" ? meter.createCounter(name) : meter.createHistogram(name, { unit: "s" }),
			]),
		);
		for (const name of ["setdraft.queue.depth", "setdraft.queue.running"] as const) {
			const samples = new Map<string, { value: number; labels: Attributes }>();
			values.set(name, samples);
			meter.createObservableGauge(name).addCallback((result) => {
				for (const sample of samples.values()) result.observe(sample.value, sample.labels);
			});
		}
		const storage = new AsyncLocalStorage<Context>();
		const propagator = new W3CTraceContextPropagator();
		const tracer = provider.getTracer("setdraft");
		let closed = false;
		let shutdown: Promise<void> | undefined;
		const runSpan = async <T>(
			parent: Context,
			spanOptions: SpanOptions,
			callback: (span: TelemetrySpan) => T | Promise<T>,
		): Promise<T> => {
			if (closed) return NOOP_TELEMETRY_CONTEXT.startSpan(spanOptions, callback);
			const span = tracer.startSpan(spanOptions.name, { attributes: attributes(spanOptions.attributes) }, parent);
			const current = trace.setSpan(parent, span);
			let settled = false;
			let explicitStatus = false;
			const handle: TelemetrySpan = {
				startSpan: (next, work) =>
					settled ? NOOP_TELEMETRY_CONTEXT.startSpan(next, work) : runSpan(current, next, work),
				addEvent: (name, input) => {
					if (!settled) span.addEvent(name, attributes(input));
				},
				setAttributes: (input) => {
					if (!settled) span.setAttributes(attributes(input));
				},
				setStatus: (status) => {
					if (settled) return;
					explicitStatus = true;
					span.setStatus({ code: status.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
				},
			};
			try {
				const result = await storage.run(current, () => callback(handle));
				if (!explicitStatus) span.setStatus({ code: SpanStatusCode.OK });
				return result;
			} catch (error) {
				span.setAttribute("error.type", errorCategory(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
				throw error;
			} finally {
				settled = true;
				span.end();
			}
		};
		const runtime: Observability = {
			enabled: true,
			startSpan: (input, work) => runSpan(storage.getStore() ?? ROOT_CONTEXT, input, work),
			capture: () => {
				const carrier: Record<string, string> = {};
				propagator.inject(storage.getStore() ?? ROOT_CONTEXT, carrier, {
					set: (target, key, value) => {
						target[key] = value;
					},
				});
				return traceCarrier(carrier);
			},
			withPropagation: (carrier, work) =>
				storage.run(
					propagator.extract(ROOT_CONTEXT, carrier ?? {}, {
						get: (target, key) => target[key as keyof typeof target],
						keys: (target) => Object.keys(target),
					}),
					work,
				),
			metric: (name, value, labels) => {
				if (closed || !Number.isFinite(value) || value < 0) return;
				const instrument = metrics.get(name);
				if (instrument && "add" in instrument) instrument.add(value, attributes(labels, true));
				else instrument?.record(value, attributes(labels, true));
			},
			gauge: (name, value, labels) => {
				if (closed || !Number.isFinite(value) || value < 0) return;
				const filtered = attributes(labels, true);
				values.get(name)?.set(JSON.stringify(filtered), { value, labels: filtered });
			},
			log: (event, input) => {
				const ids = trace.getSpanContext(storage.getStore() ?? ROOT_CONTEXT);
				const record = {
					event,
					...attributes(input),
					...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}),
				};
				try {
					(options.logger ?? ((record) => console.log(JSON.stringify(record))))(record);
				} catch {
					// A failing log sink must not interrupt business work.
				}
			},
			flush: async () => {
				await Promise.allSettled([provider.forceFlush(), meters.forceFlush()]);
			},
			shutdown: () => {
				shutdown ??= (async () => {
					closed = true;
					let timeout: NodeJS.Timeout | undefined;
					await Promise.race([
						Promise.allSettled([provider.shutdown(), meters.shutdown()]),
						new Promise<void>((resolve) => {
							timeout = setTimeout(resolve, 5000);
							timeout.unref();
						}),
					]);
					if (timeout) clearTimeout(timeout);
					storage.disable();
				})();
				return shutdown;
			},
		};
		return runtime;
	} catch {
		(options.warn ?? console.warn)("Setdraft telemetry disabled: invalid OpenTelemetry configuration.");
		return NOOP_OBSERVABILITY;
	}
}
