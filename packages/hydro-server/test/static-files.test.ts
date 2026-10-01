import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// A separate native Node process catches a real uncaught stream error without hiding it in Vitest.
const probe = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const [modulePath, root, mode] = process.argv.slice(1);
const path = root + '/index.html';
const total = 16 * 1024 * 1024;
await fsp.writeFile(path, mode === 'abort' ? Buffer.alloc(total, 'x') : 'FIRST');
const streams = [], responses = new Set();
let uncaught = 0, changed = false, served = false;
process.on('uncaughtException', () => { uncaught++; for (const response of responses) response.destroy(); });
async function replace() { if (!changed) { changed = true; await fsp.unlink(path); await fsp.writeFile(path, 'OTHER'); } }
function track(stream) { streams.push(stream); if (mode === 'error') stream.destroy(new Error('injected disk read failure')); return stream; }
const originalRead = fs.createReadStream.bind(fs), originalStat = fsp.stat.bind(fsp), originalOpen = fsp.open.bind(fsp);
fs.createReadStream = (...args) => track(originalRead(...args));
fsp.stat = async (...args) => { const result = await originalStat(...args); if (mode === 'replace') await replace(); return result; };
fsp.open = async (...args) => {
 const file = await originalOpen(...args), read = file.createReadStream.bind(file), stat = file.stat.bind(file);
 file.createReadStream = (...options) => track(read(...options));
 file.stat = async (...options) => { const result = await stat(...options); if (mode === 'replace') await replace(); return result; };
 return file;
};
syncBuiltinESMExports();
const { serveStatic } = await import(modulePath);
const server = createServer(async (_request, response) => {
 responses.add(response);
 try { served = await serveStatic(response, root, '/'); } catch { response.statusCode = 500; response.end('failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let body = '', failed = false;
try {
 const response = await fetch('http://127.0.0.1:' + server.address().port);
 if (mode === 'abort') await response.body.cancel(); else body = await response.text();
} catch { failed = true; }
await delay(100);
const closed = streams.every(stream => stream.closed || stream.destroyed);
for (const stream of streams) stream.destroy();
await new Promise(resolve => server.close(resolve));
console.log(JSON.stringify({ uncaught, served, body, failed, closed }));
`;

it.each(["error", "replace", "abort"])(
	"handles a real static file %s without uncaught errors or leaked streams",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-static-stream-"));
		try {
			const result = JSON.parse(
				execFileSync(
					process.execPath,
					[
						"--import",
						"tsx",
						"--input-type=module",
						"--eval",
						probe,
						new URL("../src/static-files.ts", import.meta.url).href,
						root,
						mode,
					],
					{ encoding: "utf8", timeout: 10_000 },
				),
			);
			expect(result.uncaught).toBe(0);
			if (mode === "replace") expect(result.body).toBe("FIRST");
			if (mode === "error") expect(result.failed).toBe(true);
			if (mode === "abort") expect(result.closed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
