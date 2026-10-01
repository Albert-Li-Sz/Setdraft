import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const commit = "df873278ab1b29510aa3a0979677d7aa9a53ca0e";
const destination = resolve(process.argv[2] || ".artifacts/qduoj-contract");
const files = [
	["fps/parser.py", "parser.py", "a31c3a8c6a73aabc5cc7b08ebd71ce917fd3170e83619c553bded0f618cf433c"],
	["problem/serializers.py", "serializers.py", "a704435b4aecb4ea56322b2b3010b8c560e4e6528adacf65dd8119c722723142"],
	["utils/serializers.py", "utils-serializers.py", "f2d654b4b141122b57e45028f6be6854cc0e587a0a031e989683cce6f65773ce"],
	["judge/languages.py", "languages.py", "a055ec943882d3ecd1f694861e38b62f6842574fdd98ae5c02d76f7ee3416877"],
];
await mkdir(destination, { recursive: true });
for (const [path, name, expected] of files) {
	let bytes = await readFile(resolve(destination, name)).catch(() => undefined);
	if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
		const response = await fetch(`https://raw.githubusercontent.com/QingdaoU/OnlineJudge/${commit}/${path}`, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`Importer source download failed (${response.status}).`);
		bytes = Buffer.from(await response.arrayBuffer());
	}
	if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Pinned importer checksum mismatch: ${name}`);
	await writeFile(resolve(destination, name), bytes);
}
console.log(`QDUOJ importer ${commit}: four source checksums verified.`);
