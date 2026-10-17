import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContestReadyRelease, type ManualRelease, verificationContractVersion } from "@setdraft/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { writeDomjudgeProblemArchive } from "../src/domjudge-export.ts";
import { writeLegacyProblemExport } from "../src/legacy-exports.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";

/**
 * The DOMjudge exporter shells out to Docker only to build and exercise the packaged validator.
 * These tests inspect the produced package bytes, so the Docker CLI is replaced by a no-op child
 * process that exits 0; every other step (including the ZIP written by the exporter) is the real
 * production code path.
 */
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: (...args: Parameters<typeof original.spawn>) =>
			args[0] === "docker"
				? original.spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] })
				: original.spawn(...args),
	};
});

const fixtureSlug = "yaml-validity";
const outsideMarker = "SETDRAFT-OUTSIDE-TESTDATA\n";
const controlTitle = "Control\u007f\u0085\u009f\u2028\u2029\ufffe\uffff tail";
const fixtureProject = {
	problemType: "standard",
	checkerMode: "text",
	checkerStandard: "cpp17",
	timeLimit: "1000ms",
	memoryLimit: "256m",
	samples: [],
	statement: "# Fixture\n\nSum two integers.\n",
	reference: { language: "python3", code: "print(3)\n" },
};

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

/** A release record that satisfies isContestReadyRelease, as the pipeline would have stored it. */
function releaseFixture(title: string): ManualRelease {
	return {
		id: "0f6f5a3e-1111-4222-8333-444455556666",
		projectId: "0f6f5a3e-aaaa-4bbb-8ccc-ddddeeeeffff",
		revision: 1,
		projectHash: "fixture-hash",
		slug: fixtureSlug,
		title,
		createdAt: "2026-01-01T00:00:00.000Z",
		scoringMode: "acm",
		checkerMode: "text",
		problemType: "standard",
		report: {
			mode: "finalize",
			success: true,
			checks: [],
			caseCount: 1,
			generatedCount: 0,
			oracleCount: 0,
			validatorUsed: false,
			checkerUsed: true,
			verificationContractVersion,
			revision: 1,
			projectHash: "fixture-hash",
			issues: [],
			verifiedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

/** Writes the release tree both exporters read: source/{project,manifest}.json plus testdata files. */
async function writeReleaseTree(
	root: string,
	title: string,
	cases: ReadonlyArray<{ inputFile: string; outputFile: string }>,
): Promise<ManualRelease> {
	await mkdir(join(root, "source", "testlib"), { recursive: true });
	await mkdir(join(root, "hydro", fixtureSlug, "testdata"), { recursive: true });
	await writeFile(join(root, "source", "project.json"), JSON.stringify(fixtureProject));
	await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ cases }));
	await writeFile(join(root, "source", "checker.cc"), "int main() { return 0; }\n");
	await writeFile(join(root, "source", "testlib", "testlib.h"), "// testlib fixture\n");
	await writeFile(join(root, "hydro", fixtureSlug, "testdata", "1.in"), "1 2\n");
	await writeFile(join(root, "hydro", fixtureSlug, "testdata", "1.out"), "3\n");
	return releaseFixture(title);
}

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "setdraft-yaml-validity-"));
	roots.push(root);
	return root;
}

/** Writes a testdata-shaped file one directory above the release testdata directory. */
async function writeOutsideFile(root: string, name: string): Promise<string> {
	const path = join(root, "hydro", name);
	await mkdir(join(root, "hydro"), { recursive: true });
	await writeFile(path, outsideMarker);
	return path;
}

/** The exporters write uncompressed ZIP32 entries, so a local-header walk reads any entry back. */
function archiveEntry(archive: Buffer, name: string): Buffer {
	const wanted = Buffer.from(name, "utf8");
	let offset = 0;
	while (offset + 30 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50) {
		const size = archive.readUInt32LE(offset + 18);
		const nameLength = archive.readUInt16LE(offset + 26);
		const extraLength = archive.readUInt16LE(offset + 28);
		const start = offset + 30 + nameLength + extraLength;
		if (archive.subarray(offset + 30, offset + 30 + nameLength).equals(wanted))
			return archive.subarray(start, start + size);
		offset = start + size;
	}
	throw new Error(`Archive entry missing: ${name}`);
}

/** YAML 1.2 c-printable; libyaml (DOMjudge's importer) rejects every other code point. */
function isYamlPrintable(codePoint: number): boolean {
	return (
		codePoint === 0x09 ||
		codePoint === 0x0a ||
		codePoint === 0x0d ||
		(codePoint >= 0x20 && codePoint <= 0x7e) ||
		codePoint === 0x85 ||
		(codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}

function unprintableCodePoints(text: string): string[] {
	const offenders = new Set<string>();
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (!isYamlPrintable(codePoint)) offenders.add(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
	}
	return [...offenders];
}

/**
 * Control: with a benign title and a benign manifest the same exporter path must succeed and yield a
 * readable archive before exercising malformed metadata and manifest entries.
 */
it("exports a benign DOMjudge package", async () => {
	const root = await temporaryRoot();
	const release = await writeReleaseTree(root, "Benign title", [{ inputFile: "1.in", outputFile: "1.out" }]);
	expect(isContestReadyRelease(release)).toBe(true);
	const archivePath = join(root, "domjudge.zip");
	await writeDomjudgeProblemArchive(root, release, "setdraft/sandbox:test", { archivePath });
	const archive = await readFile(archivePath);
	expect(archiveEntry(archive, "problem.yaml").toString("utf8")).toContain('name: "Benign title"');
	expect(archiveEntry(archive, "data/secret/001.in").toString("utf8")).toBe("1 2\n");
});

it("exports benign FPS and QDUOJ packages", async () => {
	for (const format of ["fps", "qduoj"] as const) {
		const root = await temporaryRoot();
		const release = await writeReleaseTree(root, "Benign title", [{ inputFile: "1.in", outputFile: "1.out" }]);
		const target = await writeLegacyProblemExport(root, release, format);
		expect((await readFile(target)).byteLength).toBeGreaterThan(0);
	}
});

it("preserves the title using YAML-safe escapes in the DOMjudge problem.yaml", async () => {
	const root = await temporaryRoot();
	const release = await writeReleaseTree(root, controlTitle, [{ inputFile: "1.in", outputFile: "1.out" }]);
	expect(isContestReadyRelease(release)).toBe(true);
	const archivePath = join(root, "domjudge.zip");
	await writeDomjudgeProblemArchive(root, release, "setdraft/sandbox:test", { archivePath });
	const problemYaml = archiveEntry(await readFile(archivePath), "problem.yaml").toString("utf8");
	expect(problemYaml).toContain("problem_format_version: legacy-icpc");
	expect(unprintableCodePoints(problemYaml)).toEqual([]);
	const title = problemYaml
		.split("\n")
		.find((line) => line.startsWith("name: "))
		?.slice(6);
	expect(JSON.parse(title ?? "null")).toBe(controlTitle);
	expect(problemYaml).not.toMatch(/[\u0085\u2028\u2029]/u);
});

it.each(["inputFile", "outputFile"] as const)(
	"refuses a DOMjudge manifest %s that escapes the testdata directory",
	async (field) => {
		const root = await temporaryRoot();
		const outside = await writeOutsideFile(root, "secret.dat");
		const release = await writeReleaseTree(root, "Traversal", [
			{ inputFile: "1.in", outputFile: "1.out", [field]: "../../secret.dat" },
		]);
		expect(isContestReadyRelease(release)).toBe(true);
		expect(await readFile(outside, "utf8")).toBe(outsideMarker);
		await expect(
			writeDomjudgeProblemArchive(root, release, "setdraft/sandbox:test", {
				archivePath: join(root, "domjudge.zip"),
			}),
		).rejects.toThrow("测试数据文件名无效");
	},
);

it.each([
	["fps", "inputFile"],
	["fps", "outputFile"],
	["qduoj", "inputFile"],
	["qduoj", "outputFile"],
] as const)("refuses a %s manifest %s that escapes the testdata directory", async (format, field) => {
	const root = await temporaryRoot();
	const outside = await writeOutsideFile(root, "secret.dat");
	const release = await writeReleaseTree(root, "Traversal", [
		{ inputFile: "1.in", outputFile: "1.out", [field]: "../../secret.dat" },
	]);
	expect(await readFile(outside, "utf8")).toBe(outsideMarker);
	await expect(writeLegacyProblemExport(root, release, format)).rejects.toThrow("测试数据文件名无效");
});

it("preserves titles and color names with YAML-safe escapes in a DOMjudge contest bundle", async () => {
	const root = await temporaryRoot();
	const projects = new ManualProjectStore({ root });
	const project = await projects.create("acm");
	const release = { ...releaseFixture(controlTitle), projectId: project.id };
	await writeReleaseTree(projects.releaseDirectory(release.id), release.title, [
		{ inputFile: "1.in", outputFile: "1.out" },
	]);
	await projects.database.put("release", release.id, release);
	const contests = new ContestStore(projects);
	const draft = await contests.create({ title: "Contest", slug: "contest" });
	const colorName = "Red\u009f\ufffe";
	await contests.update(draft.id, {
		...draft,
		releaseIds: [release.id],
		colorNames: { [release.id]: colorName },
	});
	const exported = await contests.export(draft.id, "domjudge");
	const bundle = await contests.releaseFile(exported.id);
	const metadata = archiveEntry(await readFile(bundle.path), "contest/problems.yaml").toString("utf8");
	expect(unprintableCodePoints(metadata)).toEqual([]);
	for (const [key, expected] of [
		["name", controlTitle],
		["color", colorName],
	]) {
		const value = metadata
			.split("\n")
			.find((line) => line.startsWith(`  ${key}: `))
			?.slice(key.length + 4);
		expect(JSON.parse(value ?? "null")).toBe(expected);
	}
});
