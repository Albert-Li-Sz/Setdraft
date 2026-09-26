/** Explicit execution controls shared by runners; independent of queues and persistence. */
export interface ExecutionContext {
	id: string;
	signal: AbortSignal;
	emit(type: string, message: string, data?: unknown): void;
}
