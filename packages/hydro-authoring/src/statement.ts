export interface HydroStatementParts {
	statement: string;
	samples: ReadonlyArray<{ input: string; output: string }>;
}

/** The exact Markdown stored as problem_zh.md and shown in the editor preview. */
export function formatHydroStatement(parts: HydroStatementParts): string {
	const statement = parts.statement.trimEnd();
	if (parts.samples.length === 0) return `${statement}\n`;
	const samples = parts.samples
		.map(
			(sample, index) =>
				`### 样例 ${index + 1}\n\n\`\`\`input${index + 1}\n${sample.input.trimEnd()}\n\`\`\`\n\n\`\`\`output${index + 1}\n${sample.output.trimEnd()}\n\`\`\``,
		)
		.join("\n\n");
	return `${statement}\n\n## 样例\n\n${samples}\n`;
}
