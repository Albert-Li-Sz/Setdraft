export class ManualProjectError extends Error {
	readonly statusCode: number;
	readonly current?: unknown;
	constructor(message: string, statusCode = 400, current?: unknown) {
		super(message);
		this.name = "ManualProjectError";
		this.statusCode = statusCode;
		this.current = current;
	}
}
