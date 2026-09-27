import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
    test: { setupFiles: [fileURLToPath(new URL("./test/database-setup.ts", import.meta.url))], hookTimeout: 30000 },
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url)) },
			{ find: /^@earendil-works\/pi-ai$/, replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)) },
			{
				find: /^@setdraft\/authoring$/,
				replacement: fileURLToPath(new URL("../hydro-authoring/src/index.ts", import.meta.url)),
			},
		],
	},
}));
