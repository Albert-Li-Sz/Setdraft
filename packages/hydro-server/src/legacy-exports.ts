import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHydroTimeLimitMs, writeStoredArchiveFromFiles } from "@hydro-problem-make/authoring";
import { formatHydroStatement } from "@hydro-problem-make/authoring/statement";
import type { ManualProject, ManualRelease } from "./manual-projects.ts";

interface SourceManifest {
	cases: Array<{ inputFile: string; outputFile: string }>;
}

const maxEmbeddedAnswerBytes = 4 * 1024 * 1024;
const maxFpsDataBytes = 8 * 1024 * 1024;

function nativeTextChecker(answers: Buffer[]): string {
	const encoded = answers.map((answer) => JSON.stringify(answer.toString("base64"))).join(",\n");
	return `#include <cctype>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

static const char* answers[] = {
${encoded}
};

std::string decode(const std::string& text) {
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    int value = 0, bits = -8;
    for (unsigned char character : text) {
        if (character == '=') break;
        int digit = static_cast<int>(alphabet.find(character));
        if (digit < 0 || digit >= 64) return "";
        value = (value << 6) + digit;
        bits += 6;
        if (bits >= 0) {
            result.push_back(static_cast<char>((value >> bits) & 255));
            bits -= 8;
        }
    }
    return result;
}

std::vector<std::string> normalized(const std::string& text) {
    std::vector<std::string> lines;
    std::string line;
    for (std::size_t index = 0; index < text.size(); ++index) {
        char character = text[index];
        if (character == '\\r') {
            if (index + 1 < text.size() && text[index + 1] == '\\n') ++index;
            character = '\\n';
        }
        if (character == '\\n') {
            while (!line.empty() && (line.back() == ' ' || line.back() == '\\t')) line.pop_back();
            lines.push_back(line);
            line.clear();
        } else {
            line.push_back(character);
        }
    }
    while (!line.empty() && (line.back() == ' ' || line.back() == '\\t')) line.pop_back();
    lines.push_back(line);
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    return lines;
}

int main(int argc, char** argv) {
    if (argc != 3) return 1;
    std::string input = argv[1];
    std::size_t slash = input.find_last_of("/\\\\");
    if (slash != std::string::npos) input = input.substr(slash + 1);
    if (input.size() < 4 || input.substr(input.size() - 3) != ".in") return 1;
    input.resize(input.size() - 3);
    if (input.empty()) return 1;
    std::size_t number = 0;
    for (unsigned char character : input) {
        if (!std::isdigit(character)) return 1;
        number = number * 10 + (character - '0');
        if (number > sizeof(answers) / sizeof(answers[0])) return 1;
    }
    if (number == 0) return 1;
    std::ifstream file(argv[2], std::ios::binary);
    if (!file) return 1;
    const std::string actual((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    return normalized(actual) == normalized(decode(answers[number - 1])) ? 0 : 1;
}
`;
}

function xml(value: string): string {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) {
		throw new Error("FPS XML 不能表示二进制控制字符，请使用 Hydro 或 DOMjudge 包。");
	}
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function element(name: string, content: string, attributes = ""): string {
	return `<${name}${attributes}>${xml(content)}</${name}>\n`;
}

function programLanguage(language: ManualProject["reference"]["language"]): string {
	if (language === "python3") return "Python3";
	if (language === "java") return "Java";
	return "C++";
}

function memoryMegabytes(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(k|m|g|kb|mb|gb)$/iu.exec(value);
	if (!match) throw new Error("发布记录的内存限制无效。");
	const unit = match[2].toLowerCase()[0];
	return Math.ceil(Number(match[1]) * (unit === "g" ? 1024 : unit === "k" ? 1 / 1024 : 1));
}

export async function writeLegacyProblemExport(
	releaseRoot: string,
	release: ManualRelease,
	format: "fps" | "qduoj",
): Promise<string> {
	if (!release.report.success || release.scoringMode !== "acm" || release.checkerMode !== "text") {
		throw new Error(
			"FPS、QDUOJ 当前只支持使用默认文本 Checker 的 ACM 题目；自定义 testlib Checker 无法按其双参数 SPJ 协议安全转换。",
		);
	}
	const project = JSON.parse(await readFile(join(releaseRoot, "source", "project.json"), "utf8")) as ManualProject;
	const manifest = JSON.parse(await readFile(join(releaseRoot, "source", "manifest.json"), "utf8")) as SourceManifest;
	if (manifest.cases.length === 0) throw new Error("发布记录没有测试点。");
	const target = join(releaseRoot, format === "fps" ? "fps.xml" : "qduoj.zip");
	if (
		await stat(target)
			.then(() => true)
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			})
	)
		return target;
	const testdata = join(releaseRoot, "hydro", release.slug, "testdata");
	const answers: Buffer[] = [];
	let answerBytes = 0;
	for (const item of manifest.cases) {
		const answer = await readFile(join(testdata, item.outputFile));
		answerBytes += answer.byteLength;
		if (answerBytes > maxEmbeddedAnswerBytes) {
			throw new Error("QDUOJ/FPS 双参数 SPJ 需要内嵌预期输出；当前答案总量超过 4 MiB，无法安全导出。");
		}
		answers.push(answer);
	}
	const checker = nativeTextChecker(answers);
	const stage = await mkdtemp(join(releaseRoot, `.${format}-`));
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		if (format === "qduoj") {
			const files = new Map<string, string>();
			for (const [index, item] of manifest.cases.entries()) {
				for (const [extension, name] of [
					["in", item.inputFile],
					["out", item.outputFile],
				] as const) {
					files.set(`testcase/${index + 1}.${extension}`, join(testdata, name));
				}
			}
			const document = {
				display_id: release.slug.slice(0, 24),
				title: release.title,
				description: { format: "markdown", value: formatHydroStatement(project) },
				input_description: { format: "markdown", value: "" },
				output_description: { format: "markdown", value: "" },
				hint: { format: "markdown", value: "" },
				tags: project.tags,
				test_case_score: manifest.cases.map((_, index) => ({
					score: 100,
					input_name: `${index + 1}.in`,
					output_name: `${index + 1}.out`,
				})),
				time_limit: parseHydroTimeLimitMs(project.timeLimit),
				memory_limit: memoryMegabytes(project.memoryLimit),
				samples: project.samples,
				template: {},
				spj: { code: checker, language: "C++" },
				rule_type: "ACM",
				source: "",
				answers: [{ code: project.reference.code, language: programLanguage(project.reference.language) }],
			};
			const jsonPath = join(stage, "problem.json");
			await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
			files.set("problem.json", jsonPath);
			await writeStoredArchiveFromFiles(temporary, "1", files);
		} else {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let dataBytes = 0;
			let body = '<?xml version="1.0" encoding="UTF-8"?>\n<fps version="1.2">\n<item>\n';
			body += element("title", release.title);
			body += element("time_limit", String(parseHydroTimeLimitMs(project.timeLimit)), ' unit="ms"');
			body += element("memory_limit", String(memoryMegabytes(project.memoryLimit)), ' unit="mb"');
			body += element("description", formatHydroStatement(project));
			body += element("input", "");
			body += element("output", "");
			for (const sample of project.samples) {
				body += element("sample_input", sample.input);
				body += element("sample_output", sample.output);
			}
			for (const item of manifest.cases) {
				const input = await readFile(join(testdata, item.inputFile));
				const output = await readFile(join(testdata, item.outputFile));
				dataBytes += input.byteLength + output.byteLength;
				if (dataBytes > maxFpsDataBytes) throw new Error("FPS XML 测试数据超过 8 MiB，请使用 ZIP 格式导出。");
				if (input.byteLength === 0)
					throw new Error("QDUOJ FPS 导入器不能创建空输入测试点，请使用 QDUOJ 原生 ZIP。");
				body += element("test_input", decoder.decode(input));
				body += element("test_output", decoder.decode(output));
			}
			body += element("spj", checker, ' language="C++"');
			body += element("source", "");
			body += element(
				"solution",
				project.reference.code,
				` language="${programLanguage(project.reference.language)}"`,
			);
			body += "</item>\n</fps>\n";
			await writeFile(temporary, body);
		}
		await rename(temporary, target);
		return target;
	} finally {
		await rm(stage, { recursive: true, force: true });
		await rm(temporary, { force: true });
	}
}
