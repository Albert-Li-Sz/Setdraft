export interface HydroStatementParts {
	statement: string;
	statementSections?: {
		description: string;
		input: string;
		output: string;
		interaction: string;
		notes: string;
		communication?: string;
		firstRound?: string;
		secondRound?: string;
	};
	problemType?: "standard" | "special" | "interactive" | "communication";
	judgingMode?: "default" | "interactive";
	samples?: Array<{ input: string; output: string }>;
	protocolSamples?: Array<{
		rounds: Array<{ round: 1 | 2; messages: Array<{ sender: "judge" | "contestant"; text: string }> }>;
	}>;
}
export function editableStatementSections(parts: HydroStatementParts) {
	return {
		description: parts.statement,
		input: "",
		output: "",
		interaction: "",
		notes: "",
		communication: "",
		firstRound: "",
		secondRound: "",
		...parts.statementSections,
	};
}
export type StatementSectionKey = keyof NonNullable<HydroStatementParts["statementSections"]>;
/** One semantic order for editors, Markdown, previews and PDF. */
export function statementSectionList(
	parts: Pick<HydroStatementParts, "problemType" | "judgingMode">,
): Array<{ key: StatementSectionKey; title: string }> {
	const type = parts.problemType ?? (parts.judgingMode === "interactive" ? "interactive" : "standard");
	return [
		{ key: "description", title: "描述" },
		...(type === "communication"
			? [
					{ key: "communication" as const, title: "通信说明" },
					{ key: "firstRound" as const, title: "第一轮协议" },
					{ key: "secondRound" as const, title: "第二轮协议" },
				]
			: type === "interactive"
				? [{ key: "interaction" as const, title: "交互协议" }]
				: [
						{ key: "input" as const, title: "输入" },
						{ key: "output" as const, title: "输出" },
					]),
		{ key: "notes", title: "提示" },
	];
}
function sampleFence(value: string, language: string): string {
	let longest = 2;
	for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
	const fence = "`".repeat(longest + 1);
	return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}
export function formatHydroStatement(parts: HydroStatementParts): string {
	const blocks = parts.statementSections
		? statementSectionList(parts)
				.map(({ key, title }) => [title, parts.statementSections?.[key] ?? ""])
				.filter(([, content]) => content.trim())
				.map(([title, content]) => `## ${title}\n\n${content.trimEnd()}`)
		: [parts.statement.trimEnd()];
	const protocol =
		parts.problemType === "communication" ||
		parts.problemType === "interactive" ||
		(!parts.problemType && parts.judgingMode === "interactive");
	if (parts.statementSections && parts.samples?.length) {
		blocks.push(
			`## ${protocol ? "旧双栏样例（消息顺序未整理）" : "样例"}\n\n${parts.samples
				.map(
					(sample, index) =>
						`### 样例 ${index + 1}\n\n${protocol ? "裁判发送\n\n" : ""}${sampleFence(sample.input, protocol ? "text" : `input${index + 1}`)}\n\n${protocol ? "选手发送\n\n" : ""}${sampleFence(sample.output, protocol ? "text" : `output${index + 1}`)}`,
				)
				.join("\n\n")}`,
		);
	}
	if (protocol && parts.protocolSamples?.length) {
		blocks.push(
			`## 协议样例\n\n${parts.protocolSamples
				.map(
					(sample, index) =>
						`### 样例 ${index + 1}\n\n${sample.rounds
							.filter((group) => parts.problemType === "communication" || group.round === 1)
							.map(
								(group) =>
									`${parts.problemType === "communication" ? `#### 第${group.round === 1 ? "一" : "二"}轮\n\n` : ""}${group.messages.map((message, messageIndex) => `**${messageIndex + 1}. ${message.sender === "judge" ? "裁判发送" : "选手发送"}**\n\n${sampleFence(message.text, "text")}`).join("\n\n")}`,
							)
							.join("\n\n")}`,
				)
				.join("\n\n")}`,
		);
	}
	return `${blocks.filter(Boolean).join("\n\n")}\n`;
}
