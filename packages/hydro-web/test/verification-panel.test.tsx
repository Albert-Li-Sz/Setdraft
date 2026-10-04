import type { ProjectSnapshot, Solution, VerificationRun } from "@setdraft/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectSession } from "../src/project-session.ts";
import { changeProjectSolutions } from "../src/solution-library.ts";
import { VerificationPanel } from "../src/VerificationPanel.tsx";
import { projectFixture } from "./project-fixture.ts";

const recorded: { run?: VerificationRun } = vi.hoisted(() => ({}));
beforeEach(() => {
	recorded.run = undefined;
});
vi.mock("../src/use-verification-history.ts", () => ({
	useVerificationHistory: () => ({
		mode: "pressure",
		runs: [],
		run: recorded.run,
		location: { solution: "wrong" },
		route: "/projects/project/runs",
		page: 1,
		select: vi.fn(),
		selectMode: vi.fn(),
		setTask: vi.fn(),
		previous: vi.fn(),
		next: vi.fn(),
	}),
}));

const wrong: Solution = {
	id: "wrong",
	name: "恒定输出",
	language: "python3",
	code: "print(0)",
	purpose: "wrong",
	expectation: { kind: "WA" },
	required: false,
};
const library = () => changeProjectSolutions(projectFixture(), (items) => [...items, wrong]);

function render(project: ProjectSnapshot) {
	const session = new ProjectSession(async (value) => value);
	try {
		session.open(project);
		return renderToStaticMarkup(
			<VerificationPanel apiOrigin="" project={project} session={session} disabled={false} />,
		);
	} finally {
		session.dispose();
	}
}

it("only selects existing incorrect solutions and exposes no program editing controls", () => {
	const project = changeProjectSolutions(library(), (items) => [
		...items,
		{ ...wrong, id: "partial", name: "部分分程序", expectation: { kind: "score", min: 10, max: 40 } },
	]);
	const html = render(project);
	expect(html).toContain("恒定输出 · WA");
	expect(html).toContain("部分分程序 · 总分区间 10–40");
	expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
	expect(html).toContain("管理错误解");
	expect(html).not.toMatch(/添加错误解|复制错误解|删除错误解|错误解名称|预期结果|发布要求/u);
	expect(html).not.toMatch(/<textarea|contenteditable|type="text"|solution-settings/u);
	expect(html).not.toContain(wrong.code);
	expect(html).not.toContain(project.reference.code);
});

it("directs an empty library to the program page and disables pressure execution", () => {
	const html = render(projectFixture());
	expect(html).toContain("尚无错误解，请在“程序与判题”中添加。");
	expect(html).toMatch(/<button[^>]*disabled=""[^>]*>运行压力测试<\/button>/u);
	expect(html).not.toContain('type="checkbox"');
	expect(html).not.toContain("添加错误解");
});

it("reflects program edits, removals and AC reclassification in the read-only target list", () => {
	const updated = changeProjectSolutions(library(), (items) =>
		items.map((item) =>
			item.id === wrong.id ? { ...item, name: "除零", code: "print(1/0)", expectation: { kind: "RE" } } : item,
		),
	);
	const html = render(updated);
	expect(html).toContain("除零 · RE");
	expect(html).not.toContain("恒定输出");
	expect(html).not.toContain("print(1/0)");
	const removed = changeProjectSolutions(updated, (items) => items.filter((item) => item.id !== wrong.id));
	expect(render(removed)).not.toContain("除零");
	const accepted = changeProjectSolutions(updated, (items) =>
		items.map((item) => (item.id === wrong.id ? { ...item, expectation: { kind: "AC" } } : item)),
	);
	expect(render(accepted)).not.toContain("除零");
	expect(accepted.solutions).toHaveLength(2);
});

it.each(["removed", "AC"])("cannot rerun a historical pressure target after it becomes %s", (change) => {
	recorded.run = {
		id: "run",
		projectId: "project",
		revision: 1,
		fingerprint: "fixture",
		image: "faux",
		createdAt: "2026-10-05T00:00:00Z",
		state: "complete",
		options: { kind: "pressure", solutionIds: [wrong.id] },
		solutions: [wrong],
		matrix: {
			cases: [],
			cells: [{ solutionId: wrong.id, caseId: "manual:1", verdict: "WA", score: 0, durationMs: 1, message: "" }],
			solutions: [],
			full: true,
			requiredPassed: false,
		},
	};
	const current = changeProjectSolutions(library(), (items) =>
		change === "removed"
			? items.filter((item) => item.id !== wrong.id)
			: items.map((item) => (item.id === wrong.id ? { ...item, expectation: { kind: "AC" } } : item)),
	);
	const html = render(current);
	expect(html).toContain("运行快照");
	expect(html).toContain(wrong.code);
	expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重跑当前解法<\/button>/u);
	expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重跑失败项<\/button>/u);
});
