import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { OAuthCredential } from "./types.ts";

export function loadOAuthCredentials(path: string): Record<string, OAuthCredential> {
	let value: unknown;
	try {
		if (!lstatSync(path).isFile()) throw new Error("Credential path must be a regular file");
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential file");
	for (const credential of Object.values(value)) {
		if (
			!credential ||
			typeof credential !== "object" ||
			credential.type !== "oauth" ||
			typeof credential.access !== "string" ||
			typeof credential.refresh !== "string" ||
			!Number.isFinite(credential.expires)
		)
			throw new Error("Invalid OAuth credential");
	}
	return value as Record<string, OAuthCredential>;
}

export function saveOAuthCredentials(path: string, credentials: Record<string, OAuthCredential>): void {
	loadOAuthCredentials(path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			chmodSync(temporary, 0o600);
			writeFileSync(fd, JSON.stringify(credentials, null, 2), "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error("Credential permissions must be 0600");
	} finally {
		rmSync(temporary, { force: true });
	}
}
