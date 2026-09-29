export interface HydroStatementParts {
	statement: string;
	statementSections?: {
		description: string;
		input: string;
		output: string;
		interaction: string;
		notes: string;
	};
	judgingMode?: "default" | "interactive";
	samples?: Array<{ input: string; output: string }>;
}

export function editableStatementSections(parts: HydroStatementParts) {
	return (
		parts.statementSections ?? { description: parts.statement, input: "", output: "", interaction: "", notes: "" }
	);
}

function sampleFence(value: string, language: string): string {
	let longest = 2;
	for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
	const fence = "`".repeat(longest + 1);
	return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function formatHydroStatement(parts: HydroStatementParts): string {
	if (!parts.statementSections) return `${parts.statement.trimEnd()}\n`;
	const sections = parts.statementSections;
	const interactive = parts.judgingMode === "interactive";
	const blocks = [
		["描述", sections.description],
		...(interactive
			? [["交互描述", sections.interaction]]
			: [
					["输入", sections.input],
					["输出", sections.output],
				]),
		["提示", sections.notes],
	]
		.filter(([, content]) => content.trim())
		.map(([title, content]) => `## ${title}\n\n${content.trimEnd()}`);
	if (parts.samples?.length) {
		blocks.push(
			`## 样例\n\n${parts.samples
				.map(
					(sample, index) =>
						`### 样例 ${index + 1}\n\n${sampleFence(sample.input, `input${index + 1}`)}\n\n${sampleFence(sample.output, `output${index + 1}`)}`,
				)
				.join("\n\n")}`,
		);
	}
	return `${blocks.join("\n\n")}\n`;
}
