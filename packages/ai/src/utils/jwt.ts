/** Decode JWT payloads without Node-only APIs or Latin-1 corruption. Signature verification belongs to the provider. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(parts[1])) throw new Error("Invalid JWT payload");
	const base64 = parts[1].replace(/-/gu, "+").replace(/_/gu, "/");
	const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
		char.charCodeAt(0),
	);
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JWT payload object");
	return value as Record<string, unknown>;
}
