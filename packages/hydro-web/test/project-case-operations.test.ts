import { afterEach, expect, it, vi } from "vitest";
import { authFetch } from "../src/auth-client.ts";
import { addProjectTextCase, manageProjectCases } from "../src/project-case-operations.ts";
import { ProjectSession } from "../src/project-session.ts";
import { projectFixture } from "./project-fixture.ts";

vi.mock("../src/auth-client.ts", () => ({ authFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("does not send an old renumber confirmation to the replacement project or a reopened session", async () => {
	const session = new ProjectSession(async (project) => project);
	session.open(projectFixture({ id: "a" }));
	const scope = { projectId: "a", signal: session.signal, expectedRevision: 1 };
	for (const id of ["b", "a"]) {
		session.open(projectFixture({ id, revision: 8, caseSubtasks: { "manual:8": 2 } }));
		await expect(manageProjectCases(session, "", scope, "renumber")).rejects.toMatchObject({ name: "AbortError" });
		expect(session.getSnapshot().project?.caseSubtasks).toEqual({ "manual:8": 2 });
	}
	expect(authFetch).not.toHaveBeenCalled();
	session.dispose();
});

it("rejects a confirmation whose revision changed while saving edits", async () => {
	const session = new ProjectSession(async (project) => ({ ...project, revision: project.revision + 1 }));
	session.open(projectFixture());
	const scope = { projectId: "project", signal: session.signal, expectedRevision: 1 };
	session.edit((project) => ({ ...project, title: "pending edit" }));
	await expect(manageProjectCases(session, "", scope, "renumber")).rejects.toThrow("重新预览");
	expect(authFetch).not.toHaveBeenCalled();
	session.dispose();
});

it("submits the confirmed project's revision and ignores a response after switching projects", async () => {
	let respond!: (response: Response) => void;
	vi.mocked(authFetch).mockImplementationOnce(
		async () =>
			await new Promise<Response>((resolve) => {
				respond = resolve;
			}),
	);
	const session = new ProjectSession(async (project) => project);
	session.open(projectFixture({ id: "a", revision: 7 }));
	const flight = manageProjectCases(
		session,
		"",
		{ projectId: "a", signal: session.signal, expectedRevision: 7 },
		"renumber",
	);
	await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce());
	expect(authFetch).toHaveBeenCalledWith(
		"/api/projects/a/cases/renumber",
		expect.objectContaining({ headers: expect.objectContaining({ "x-expected-revision": "7" }) }),
	);
	session.open(projectFixture({ id: "b" }));
	respond(new Response(JSON.stringify(projectFixture({ id: "a", revision: 8 }))));
	await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	expect(session.getSnapshot().project?.id).toBe("b");
	session.dispose();
});

it("preserves a text case draft if authentication pauses before dispatch", async () => {
	const session = new ProjectSession(async (project) => project);
	session.open(projectFixture());
	session.pause();
	const draft = { input: "1 2", output: "3", subtaskId: 1 };
	let cleared = false;
	const flight = addProjectTextCase(session, "", draft).then(() => {
		cleared = true;
	});
	await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	expect(cleared).toBe(false);
	expect(authFetch).not.toHaveBeenCalled();
	session.resume();
	expect(authFetch).not.toHaveBeenCalled();
	session.dispose();
});
it("preserves a text case draft on a late successful response after authentication pauses", async () => {
	let respond!: (response: Response) => void;
	vi.mocked(authFetch).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				respond = resolve;
			}),
	);
	const session = new ProjectSession(async (project) => project);
	session.open(projectFixture());
	let cleared = false;
	const flight = addProjectTextCase(session, "", { input: "1 2", output: "3", subtaskId: 1 }).then(() => {
		cleared = true;
	});
	await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce());
	session.pause();
	respond(new Response(JSON.stringify({ inputFile: "1.in", project: projectFixture() })));
	await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	expect(cleared).toBe(false);
	session.resume();
	expect(authFetch).toHaveBeenCalledOnce();
	session.dispose();
});
