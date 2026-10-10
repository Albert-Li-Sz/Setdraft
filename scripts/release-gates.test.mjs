import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveImageTags } from "./docker-image-tags.mjs";

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
	assert.match(publish, /\n  build:\n    needs: \[check, image-tags\]\n/u);
	assert.match(publish, /needs: \[check, image-tags, build\]/u);
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

test("stable images publish a project version and latest, with the Rev release alias retained", () => {
	assert.deepEqual(resolveImageTags("1.6.0", "refs/heads/main"), { version: "1.6.0", tags: ["1.6.0", "latest"] });
	assert.deepEqual(resolveImageTags("1.6.0", "refs/tags/Rev1.6"), { version: "1.6.0", tags: ["1.6.0", "Rev1.6", "latest"] });
	assert.deepEqual(resolveImageTags("1.6.1", "refs/tags/v1.6.1"), { version: "1.6.1", tags: ["1.6.1", "latest"] });
	assert.deepEqual(resolveImageTags("1.6.1", "refs/tags/Rev1.6.1"), { version: "1.6.1", tags: ["1.6.1", "Rev1.6.1", "latest"] });
});

test("prerelease images keep their version tags without replacing latest", () => {
	for (const ref of ["refs/heads/main", "refs/tags/v1.7.0-rc.1"])
		assert.deepEqual(resolveImageTags("1.7.0-rc.1", ref).tags, ["1.7.0-rc.1"]);
	assert.deepEqual(resolveImageTags("1.7.0-rc.1", "refs/tags/Rev1.7-rc.1").tags, ["1.7.0-rc.1", "Rev1.7-rc.1"]);
});

test("publishing rejects mismatched releases, non-release branches and invalid project versions", () => {
	for (const ref of ["refs/tags/Rev1.5", "refs/tags/v1.6.1"])
		assert.throws(() => resolveImageTags("1.6.0", ref), /does not match/u);
	for (const ref of ["refs/heads/Pre", "refs/tags/other", "refs/tags/v1.6.0\nlatest", "refs/tags/Rev1.6\n", undefined])
		assert.throws(() => resolveImageTags("1.6.0", ref), /only be published/u);
	for (const version of [undefined, "", "sha-123456", "1.6", "1.6.0+metadata", "1.6.0\nlatest", "1.6.0\n", `1.6.0-${"a".repeat(123)}`])
		assert.throws(() => resolveImageTags(version, "refs/heads/main"), /Docker-compatible/u);
});
