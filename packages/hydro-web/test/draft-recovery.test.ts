import { expect, it } from "vitest";
import { draftDifferences, mergeDraft } from "../src/draft-merge.ts";
import { DraftRecoveryStore } from "../src/draft-recovery.ts";
import { ProjectSession } from "../src/project-session.ts";
import { projectFixture } from "./project-fixture.ts";

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}
it("ignores JSON object key order in history and merges unchanged arrays from PostgreSQL snapshots", () => {
	const before = projectFixture({ samples: [{ input: "1", output: "2" }] });
	const local = { ...before, samples: [{ output: "2", input: "1" }] };
	const server = { ...before, revision: 2, samples: [{ input: "3", output: "4" }] };
	expect(draftDifferences(before, local)).toEqual([]);
	expect(mergeDraft(before, local, server)).toMatchObject({ conflicts: [], project: { samples: server.samples } });
});
it("blocks an external refresh with competing edits while merging independent server fields", async () => {
	const session = new ProjectSession(async (project) => ({ ...project, revision: project.revision + 1 }));
	const base = projectFixture();
	session.open(base);
	session.edit((project) => ({ ...project, title: "local" }));
	session.receive({ ...base, revision: 2, slug: "changed" });
	expect(session.getSnapshot()).toMatchObject({ status: "dirty", project: { title: "local", slug: "changed" } });
	session.receive({ ...base, revision: 3, slug: "changed", title: "server" });
	expect(session.getSnapshot()).toMatchObject({
		status: "conflict",
		project: { title: "local" },
		conflict: { title: "server" },
	});
	await expect(session.flush()).rejects.toThrow("题目版本");
	session.dispose();
});
it("keeps independent tab recovery records, isolates users and survives reload", () => {
	const storage = new MemoryStorage(),
		first = new DraftRecoveryStore(storage, "a"),
		second = new DraftRecoveryStore(storage, "a");
	const base = projectFixture();
	first.write(base, { ...base, title: "first tab" });
	second.write(base, { ...base, title: "second tab" });
	expect(new DraftRecoveryStore(storage, "b").list(base.id)).toEqual([]);
	expect(
		new DraftRecoveryStore(storage, "a")
			.list(base.id)
			.map((entry) => entry.project.title)
			.sort(),
	).toEqual(["first tab", "second tab"]);
	first.saved(base.id);
	expect(new DraftRecoveryStore(storage, "a").list(base.id).map((entry) => entry.project.title)).toEqual([
		"second tab",
	]);
	second.discard("setdraft.unsaved.v1:b:foreign");
	expect(storage.length).toBe(1);
});
it("keeps a remotely added program while rebasing local source edits during refresh", async () => {
	const primary = {
		id: "reference",
		name: "Primary",
		language: "python3" as const,
		code: "print(1)",
		purpose: "accepted" as const,
		required: true,
		expectation: { kind: "AC" as const },
	};
	const base = projectFixture({ solutions: [primary], referenceSolutionId: "reference" });
	const session = new ProjectSession(async (project) => ({ ...project, revision: project.revision + 1 }));
	session.open(base);
	session.edit((project) => ({ ...project, solutions: [{ ...primary, code: "print(2)" }] }));
	session.receive({ ...base, revision: 2, solutions: [primary, { ...primary, id: "added", required: false }] });
	await session.flush();
	expect(session.getSnapshot().project).toMatchObject({
		revision: 3,
		reference: { code: "print(2)" },
		solutions: [
			{ id: "reference", code: "print(2)" },
			{ id: "added", code: "print(1)" },
		],
	});
	session.dispose();
});
it("rejects malformed local data and reports quota failures without replacing another record", () => {
	const storage = new MemoryStorage();
	storage.setItem("setdraft.unsaved.v1:a:malformed", "broken");
	const store = new DraftRecoveryStore(storage, "a");
	expect(store.list()).toEqual([]);
	storage.setItem = () => {
		throw new DOMException("QuotaExceededError");
	};
	expect(() => store.write(projectFixture(), projectFixture({ title: "pending" }))).toThrow();
	expect(storage.length).toBe(1);
});
it("merges independent solution edits by ID and requires selection for the same source field", async () => {
	const solution = {
		id: "reference",
		name: "Primary",
		language: "python3" as const,
		code: "print(1)",
		purpose: "accepted" as const,
		required: true,
		expectation: { kind: "AC" as const },
	};
	const base = projectFixture({ solutions: [solution], referenceSolutionId: solution.id });
	const local = { ...base, title: "Local title", solutions: [{ ...solution, code: "print(2)" }] };
	const server = {
		...base,
		revision: 3,
		slug: "server-slug",
		solutions: [{ ...solution, code: "print(3)", name: "Renamed remotely" }],
	};
	const merged = mergeDraft(base, local, server);
	expect(merged.conflicts.map((entry) => entry.path)).toEqual(["solutions[reference].code"]);
	const session = new ProjectSession(async (project) => ({ ...project, revision: project.revision + 1 }));
	session.open(base);
	session.edit(() => local);
	session.conflict(server);
	expect(() => session.resolveConflict({})).toThrow("请选择");
	session.resolveConflict({ "solutions[reference].code": "local" });
	await session.flush();
	expect(session.getSnapshot().project).toMatchObject({
		title: "Local title",
		slug: "server-slug",
		revision: 4,
		reference: { code: "print(2)" },
		solutions: [{ name: "Renamed remotely", code: "print(2)" }],
	});
	session.dispose();
});
it("shows a deletion-versus-edit conflict without losing unrelated new programs or remote case metadata", () => {
	const accepted = {
		id: "reference",
		name: "Primary",
		language: "python3" as const,
		code: "print(1)",
		purpose: "accepted" as const,
		required: true,
		expectation: { kind: "AC" as const },
	};
	const auxiliary = { ...accepted, id: "aux", required: false };
	const base = projectFixture({ solutions: [accepted, auxiliary], referenceSolutionId: "reference" });
	const local = { ...base, solutions: [accepted] };
	const server = {
		...base,
		solutions: [accepted, { ...auxiliary, code: "changed" }, { ...auxiliary, id: "new" }],
		cases: [{ id: "1", origin: "manual" as const, inputFile: "1.in", inputBytes: 1, subtaskId: 1 }],
	};
	const merged = mergeDraft(base, local, server, { "solutions[aux]": "server" });
	expect(merged.conflicts[0].path).toBe("solutions[aux]");
	expect(merged.project.solutions?.map((item) => item.id)).toEqual(["reference", "aux", "new"]);
	expect(merged.project.cases).toEqual(server.cases);
	expect(draftDifferences(base, server).map((entry) => entry.path)).toEqual(
		expect.arrayContaining(["solutions[aux].code", "solutions[new]", "cases"]),
	);
});
