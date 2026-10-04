import { describe, expect, it } from "vitest";
import { editableStatementSections, formatHydroStatement } from "../src/statement.ts";

const statementSections = {
	description: "Description with $a+b$.",
	input: "Private ordinary input format.",
	output: "Ordinary output format.",
	interaction: "Send a query and flush.",
	notes: "Remember the limits.",
};

describe("structured statement formatting", () => {
	it("preserves legacy Markdown exactly apart from its trailing newline", () => {
		const statement = "# Original title\n\n## 输入\n\nOriginal content.\n\n";
		expect(formatHydroStatement({ statement, samples: [{ input: "1", output: "2" }] })).toBe(
			"# Original title\n\n## 输入\n\nOriginal content.\n",
		);
		expect(editableStatementSections({ statement })).toEqual({
			description: statement,
			input: "",
			output: "",
			interaction: "",
			notes: "",
			communication: "",
			firstRound: "",
			secondRound: "",
		});
	});

	it("uses ordinary sections in their editor order and appends numbered samples", () => {
		const statement = formatHydroStatement({
			statement: "stale legacy content",
			statementSections,
			samples: [{ input: "1 2\n", output: "3" }],
		});
		expect(statement).toBe(
			"## 描述\n\nDescription with $a+b$.\n\n## 输入\n\nPrivate ordinary input format.\n\n## 输出\n\nOrdinary output format.\n\n## 提示\n\nRemember the limits.\n\n## 样例\n\n### 样例 1\n\n```input1\n1 2\n```\n\n```output1\n3\n```\n",
		);
		expect(statement).not.toContain(statementSections.interaction);
	});

	it("switches only the visible section set for interactive statements", () => {
		const statement = formatHydroStatement({ statement: "", statementSections, judgingMode: "interactive" });
		expect(statement).toContain("## 交互协议\n\nSend a query and flush.");
		expect(statement).not.toContain(statementSections.input);
		expect(statement).not.toContain(statementSections.output);
		expect(editableStatementSections({ statement: "", statementSections })).toEqual({
			...statementSections,
			communication: "",
			firstRound: "",
			secondRound: "",
		});
	});

	it("omits empty sections and cannot close code fences with sample content", () => {
		const statement = formatHydroStatement({
			statement: "",
			statementSections: { description: "", input: " ", output: "", interaction: "", notes: "" },
			samples: [{ input: "```\n# Not a heading", output: "" }],
		});
		expect(statement).toBe("## 样例\n\n### 样例 1\n\n````input1\n```\n# Not a heading\n````\n\n```output1\n\n```\n");
	});

	it("handles the maximum sample size without spreading all backtick runs onto the call stack", () => {
		const input = "` ".repeat(100_000);
		const statement = formatHydroStatement({ statement: "", statementSections, samples: [{ input, output: "" }] });
		expect(statement).toContain(`\n\n\`\`\`input1\n${input}\n\`\`\``);
	});
	it("formats both communication rounds in order and retains legacy two-column examples", () => {
		const parts = {
			statement: "",
			problemType: "communication" as const,
			statementSections: {
				...statementSections,
				communication: "Start twice.",
				firstRound: "Encode.",
				secondRound: "Decode.",
			},
			samples: [{ input: "legacy jury", output: "legacy program" }],
			protocolSamples: [
				{
					rounds: [
						{
							round: 1 as const,
							messages: [
								{ sender: "judge" as const, text: "first\n21\n" },
								{ sender: "contestant" as const, text: "42\n" },
							],
						},
						{
							round: 2 as const,
							messages: [
								{ sender: "judge" as const, text: "second\n42\n" },
								{ sender: "contestant" as const, text: "21\n```\n" },
							],
						},
					],
				},
			],
		};
		const result = formatHydroStatement(parts);
		expect([...result.matchAll(/^## (.*)$/gm)].map((match) => match[1])).toEqual([
			"描述",
			"通信说明",
			"第一轮协议",
			"第二轮协议",
			"提示",
			"旧双栏样例（消息顺序未整理）",
			"协议样例",
		]);
		expect(result).toContain("#### 第一轮\n\n**1. 裁判发送**");
		expect(result).toContain("#### 第二轮\n\n**1. 裁判发送**");
		expect(result).toContain("````text\n21\n```\n````");
		expect(result).not.toContain("```input");
		const interactive = formatHydroStatement({ ...parts, problemType: "interactive" });
		expect(interactive).not.toContain("second\n42");
		expect(interactive).not.toContain("Start twice.");
		expect(interactive).toContain("legacy jury");
	});
});
