/** Keep existing package units compatible while presenting unit-free numeric inputs. */
export function limitAmount(value: string, kind: "time" | "memory"): string {
	const match = /^(\d+(?:\.\d+)?)(ms|s|k|m|g|kb|mb|gb)$/i.exec(value);
	if (!match) return value;
	const unit = match[2].toLowerCase();
	const factor =
		kind === "time" ? (unit === "s" ? 1000 : 1) : unit.startsWith("g") ? 1024 : unit.startsWith("k") ? 1 / 1024 : 1;
	return String(Number(match[1]) * factor);
}
