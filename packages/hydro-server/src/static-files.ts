import { type FileHandle, open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const contentTypes: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

export async function serveStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<boolean> {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(pathname);
	} catch {
		return false;
	}
	const requestedPath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
	const root = resolve(staticRoot),
		filePath = resolve(root, requestedPath);
	if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;
	let file: FileHandle | undefined;
	try {
		file = await open(filePath, "r");
		const metadata = await file.stat();
		if (!metadata.isFile()) return false;
		if (response.destroyed) return true;
		response.writeHead(200, {
			"content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
			"content-length": metadata.size,
		});
		await pipeline(file.createReadStream(), response);
		return true;
	} catch (error) {
		if (response.headersSent || response.destroyed) {
			response.destroy();
			return true;
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	} finally {
		await file?.close();
	}
}
