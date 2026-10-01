/** Explicit execution controls shared by runners; independent of queues and persistence. */
export interface ExecutionContext {
	id: string;
	signal: AbortSignal;
	observability?: Observability;
	emit(type: string, message: string, data?: unknown): void;
}

import type { Observability } from "./observability.ts";
