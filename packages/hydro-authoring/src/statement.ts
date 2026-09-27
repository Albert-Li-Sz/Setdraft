export interface HydroStatementParts {
	statement: string;
}

/** Statement-only Markdown. Public samples remain separate test data in supported exports. */
export function formatHydroStatement(parts: HydroStatementParts): string {
	return `${parts.statement.trimEnd()}\n`;
}
