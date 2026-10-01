import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ordinary AI builds consume checked-in model snapshots, never refresh the catalog", async () => {
	const { scripts } = JSON.parse(await read("packages/ai/package.json"));
	assert.equal(scripts.build, "npm run build:offline");
	assert.doesNotMatch(scripts["build:offline"], /generate-|hydrate-/u);
	assert.match(scripts["generate-models"], /--strict/u);
});

test("CI and every image push depend on the same full source and Linux sandbox checks", async () => {
	const ci = await read(".github/workflows/ci.yml");
	const publish = await read(".github/workflows/docker-publish.yml");
	const verify = await read(".github/workflows/verify.yml");
	for (const source of [ci, publish]) assert.match(source, /uses: \.\/\.github\/workflows\/verify.yml/u);
	assert.match(publish, /\n  build:\n    needs: check\n/u);
	assert.match(publish, /needs: \[check, build\]/u);
	assert.match(verify, /node: \[22, 24\]/u);
	for (const command of ["npm run build", "npm run check", "npm test", "git diff --exit-code", "npm run test --workspace=@setdraft/server"])
		assert.ok(verify.includes(`run: ${command}`));
	assert.match(verify, /SETDRAFT_REQUIRE_SANDBOX: '1'/u);
	assert.match(verify, /SETDRAFT_DATABASE_URL: postgresql:\/\/setdraft_app:/u);
	assert.match(verify, /node packages\/hydro-server\/dist\/migrate-cli.js/u);
	assert.match(publish, /full-e2e: true/u);
	assert.match(verify, /if: matrix.node == 24 && !inputs.full-e2e/u);
	assert.match(verify, /if: inputs.full-e2e/u);
	assert.match(verify, /run: npm run test:e2e:full/u);
	assert.match(verify, /run: npm run test:e2e\n/u);
});
