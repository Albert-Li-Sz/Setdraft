import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url)) },
			{ find: /^@earendil-works\/pi-ai$/, replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)) },
			{
				find: /^@hydro-problem-make\/authoring$/,
				replacement: fileURLToPath(new URL("../hydro-authoring/src/index.ts", import.meta.url)),
			},
		],
	},
}));
