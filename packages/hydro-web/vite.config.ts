import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Keep PDF fonts, character maps and codecs local for private/offline deployments.
export default defineConfig(async () => {
	const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
	const assets = new Map<string, Uint8Array>();
	for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
		for (const name of await readdir(join(root, directory))) {
			assets.set(`pdf-assets/${directory}/${name}`, await readFile(join(root, directory, name)));
		}
	}
	return {
		plugins: [
			react(),
			{
				name: "local-pdf-assets",
				generateBundle() {
					for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source });
				},
				configureServer(server) {
					server.middlewares.use((request, response, next) => {
						const name = request.url?.split("?")[0].slice(1) ?? "";
						const asset = assets.get(name);
						if (!asset) return next();
						response.setHeader(
							"Content-Type",
							name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
						);
						response.end(asset);
					});
				},
			} satisfies Plugin,
		],
		build: {
			rolldownOptions: {
				output: {
					strictExecutionOrder: true,
					codeSplitting: {
						groups: [
							{ name: "pdf-renderer", test: /node_modules[/]pdfjs-dist[/]/ },
							{ name: "editor", test: /node_modules[/](?:@codemirror|@lezer|codemirror)[/]/, maxSize: 500_000 },
							{ name: "math", test: /node_modules[/]katex[/]/ },
						],
					},
				},
			},
		},
		server: { host: "127.0.0.1", port: 5173, proxy: { "/api": "http://127.0.0.1:4321" } },
	};
});
