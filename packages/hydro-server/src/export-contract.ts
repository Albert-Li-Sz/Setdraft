import { exportContractVersion } from "@setdraft/contracts";

export function exportFileName(format: "domjudge" | "fps" | "qduoj"): string {
	return `${format}.v${exportContractVersion}.${format === "fps" ? "xml" : "zip"}`;
}
