import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFlatName } from "@setdraft/authoring";
import { exportContractVersion } from "@setdraft/contracts";

export function exportFileName(format: "domjudge" | "fps" | "qduoj"): string {
	return `${format}.v${exportContractVersion}.${format === "fps" ? "xml" : "zip"}`;
}

export async function readExportManifest(
	releaseRoot: string,
): Promise<{ cases: Array<{ inputFile: string; outputFile: string }> }> {
	const manifest: unknown = JSON.parse(await readFile(join(releaseRoot, "source", "manifest.json"), "utf8"));
	if (!manifest || typeof manifest !== "object" || !("cases" in manifest) || !Array.isArray(manifest.cases))
		throw new Error("发布记录的测试数据清单无效。");
	const cases = manifest.cases.map((item: unknown) => {
		if (
			!item ||
			typeof item !== "object" ||
			!("inputFile" in item) ||
			typeof item.inputFile !== "string" ||
			!isSafeFlatName(item.inputFile) ||
			!("outputFile" in item) ||
			typeof item.outputFile !== "string" ||
			!isSafeFlatName(item.outputFile)
		)
			throw new Error("发布记录的测试数据文件名无效。");
		return { inputFile: item.inputFile, outputFile: item.outputFile };
	});
	if (!cases.length) throw new Error("发布记录没有测试点。");
	return { cases };
}

/** JSON quoting needs additional escapes for YAML's printable and line-break rules. */
export function yamlString(value: string): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/gu,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
