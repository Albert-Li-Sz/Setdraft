/** Each word may match a different field; width and letter case do not change the search. */
export function matchesSearch(query: string, fields: readonly string[]): boolean {
	const text = fields.join(" ").normalize("NFKC").toLocaleLowerCase();
	return query
		.normalize("NFKC")
		.trim()
		.toLocaleLowerCase()
		.split(/\s+/u)
		.every((word) => text.includes(word));
}
