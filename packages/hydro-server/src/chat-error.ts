export class ChatError extends Error {
	readonly statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.name = "ChatError";
		this.statusCode = statusCode;
	}
}
