import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSafeFlatName } from "@setdraft/authoring";
import type { GeneratorCommand, ManualCaseSummary } from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";

const dataNamePattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(in|out|ans)$/;
export function dataStem(name: string): { stem: string; extension: "in" | "out" | "ans" } {
	const match = dataNamePattern.exec(name);
	if (!match || !isSafeFlatName(name))
		throw new ManualProjectError("测试文件名必须是平铺的 .in、.out 或 .ans 文件名。", 400);
	return { stem: match[1], extension: match[2] as "in" | "out" | "ans" };
}

/** Parse one gen invocation per line without invoking a shell. */
export function parseGeneratorScript(script: string): GeneratorCommand[] {
	const commands: GeneratorCommand[] = [];
	for (const [index, line] of script.split(/\r?\n/u).entries()) {
		const tokens: string[] = [];
		let token = "";
		let quote: "'" | '"' | undefined;
		let started = false;
		let escaped = false;
		for (const character of line) {
			if (escaped) {
				token += character;
				escaped = false;
				started = true;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (quote) {
				if (character === quote) quote = undefined;
				else token += character;
				continue;
			}
			if (character === "'" || character === '"') {
				quote = character;
				started = true;
				continue;
			}
			if (character === "#") break;
			if (/[|;&<>$`]/u.test(character))
				throw new ManualProjectError(`生成脚本第 ${index + 1} 行包含 Shell 操作符。`);
			if (/\s/u.test(character)) {
				if (started) tokens.push(token);
				token = "";
				started = false;
			} else {
				token += character;
				started = true;
			}
		}
		if (quote || escaped) throw new ManualProjectError(`生成脚本第 ${index + 1} 行引号或转义不完整。`);
		if (started) tokens.push(token);
		if (tokens.length === 0) continue;
		if (!/^gen(?:_[1-9]\d{0,8})?$/u.test(tokens[0]))
			throw new ManualProjectError(`生成脚本第 ${index + 1} 行必须以 Gen 编号开头，如 gen、gen_1。`);
		if (tokens.length > 64 || tokens.some((item) => item.length > 1000)) {
			throw new ManualProjectError(`生成脚本第 ${index + 1} 行参数过多或过长。`);
		}
		commands.push({ generator: tokens[0], args: tokens.slice(1), line: index + 1 });
	}
	return commands;
}

export async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const block of createReadStream(path)) hash.update(block);
	return hash.digest("hex");
}

export async function fileEntries(directory: string): Promise<Array<{ name: string; size: number }>> {
	try {
		const result: Array<{ name: string; size: number }> = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile()) throw new ManualProjectError(`项目数据目录包含非普通文件：${entry.name}`);
			dataStem(entry.name);
			result.push({ name: entry.name, size: (await stat(join(directory, entry.name))).size });
		}
		return result;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function caseOrder(left: ManualCaseSummary, right: ManualCaseSummary): number {
	if (left.origin !== right.origin) return left.origin === "manual" ? -1 : 1;
	const leftNumber = /^\d+$/u.test(left.id) ? Number(left.id) : Number.POSITIVE_INFINITY;
	const rightNumber = /^\d+$/u.test(right.id) ? Number(right.id) : Number.POSITIVE_INFINITY;
	if (leftNumber !== rightNumber) return leftNumber - rightNumber;
	return left.id.localeCompare(right.id, "en");
}
