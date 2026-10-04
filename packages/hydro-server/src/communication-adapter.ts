import type { CommunicationConfig } from "@setdraft/contracts";
import { defaultTextChecker } from "./acm-checker.ts";

const magic = "SETDRAFT_COMMUNICATION_2";
const initialMagic = "SETDRAFT_COMMUNICATION_1";
export function communicationInitialInput(original: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`${initialMagic} ${original.length}\n`), original]);
}
export function readCommunicationInitialInput(bytes: Buffer): Buffer {
	const end = bytes.indexOf(10);
	const match = /^SETDRAFT_COMMUNICATION_1 ([0-9]+)$/u.exec(bytes.subarray(0, end).toString("ascii"));
	if (end < 0 || !match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) !== bytes.length - end - 1)
		throw new Error("通信第一轮私有输入封装无效。");
	return bytes.subarray(end + 1);
}
/** Bounded, length-delimited binary envelope carried only as the next jury input. */
export function readCommunicationEnvelope(
	bytes: Buffer,
	maximum: number,
): { original: Buffer; handoff: Buffer; secondInput: Buffer } {
	if (bytes.length > maximum) throw new Error("通信交接超过容量限制。");
	const end = bytes.indexOf(10);
	const header = bytes.subarray(0, end).toString("ascii");
	const match = /^SETDRAFT_COMMUNICATION_2 ([0-9]+) ([0-9]+) ([0-9]+)$/u.exec(header);
	if (end < 0 || !match) throw new Error("通信裁判未生成合法交接文件。");
	const sizes = match.slice(1).map(Number);
	if (
		sizes.some((size) => !Number.isSafeInteger(size) || size < 0) ||
		sizes[1] > 1048576 ||
		sizes[2] > 1048576 ||
		sizes.reduce((a, b) => a + b, end + 1) !== bytes.length
	)
		throw new Error("通信交接长度无效。");
	const start = end + 1;
	return {
		original: bytes.subarray(start, start + sizes[0]),
		handoff: bytes.subarray(start + sizes[0], start + sizes[0] + sizes[1]),
		secondInput: bytes.subarray(start + sizes[0] + sizes[1]),
	};
}

/** This source is used unchanged by local execution and both judge exports. */
export function communicationAdapter(
	config: CommunicationConfig,
	checkerSource: string,
	platform: "local" | "hydro" | "domjudge",
	maximum = 64 * 1024 * 1024,
): string {
	const judge = config.judgeSource.replace(/^\s*#\s*include\s*[<"]setdraft_communication\.h[>"]\s*$/gmu, "");
	const checker = config.secondRound === "custom" ? checkerSource : defaultTextChecker;
	return `#include "testlib.h"
#include <bits/stdc++.h>
#include <unistd.h>
#include <sys/wait.h>

namespace setdraft_comm {
int currentRound = 1;
std::string original, handoff, secondInput, nextPath, originalPath, outputPath, answerPath;
bool saved = false;
const size_t maximum = ${maximum};
std::string read(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) quitf(_fail, "Cannot read communication file");
    std::string data; char block[8192];
    while (f.read(block, sizeof(block)) || f.gcount()) {
        data.append(block, (size_t)f.gcount());
        if (data.size() > maximum) quitf(_fail, "Communication file too large");
    }
    return data;
}
void write(const std::string& path, const std::string& data) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f.write(data.data(), data.size()); f.close();
    if (!f) quitf(_fail, "Cannot save communication file");
}
void decode(const std::string& data) {
    size_t e = data.find('\\n');
    if (e == std::string::npos) quitf(_fail, "Missing handoff envelope");
    std::istringstream h(data.substr(0, e)); std::string tag, extra; unsigned long long a, b, c;
    if (!(h >> tag >> a >> b >> c) || h >> extra || tag != "${magic}" || a > maximum || b > 1048576 || c > 1048576 || a + b + c != data.size() - e - 1) quitf(_fail, "Invalid handoff envelope");
    original = data.substr(e + 1, a); handoff = data.substr(e + 1 + a, b); secondInput = data.substr(e + 1 + a + b, c);
}
}
int communicationRound() { return setdraft_comm::currentRound; }
const std::string& communicationHandoff() { return setdraft_comm::handoff; }
void saveCommunicationHandoff(const std::string& data, const std::string& secondInput = "") {
    using namespace setdraft_comm;
    if (currentRound != 1 || saved || data.size() > 1048576 || secondInput.size() > 1048576) quitf(_fail, "Invalid handoff request; exactly two rounds are allowed");
    std::string envelope = "${magic} " + std::to_string(original.size()) + " " + std::to_string(data.size()) + " " + std::to_string(secondInput.size()) + "\\n" + original + data + secondInput;
    if (envelope.size() > maximum) quitf(_fail, "Handoff exceeds file capacity");
    write(nextPath, envelope); saved = true;
}
NORETURN void setdraftCommunicationQuit(TResult result, const char* format, ...) {
    char text[4096]; va_list args; va_start(args, format); vsnprintf(text, sizeof(text), format, args); va_end(args);
    if (setdraft_comm::currentRound == 1 && result == _ok && !setdraft_comm::saved) quitf(_fail, "Round one accepted without a handoff");
    quitf(result, "%s", text);
}
#define main setdraft_judge_main
#define quitf setdraftCommunicationQuit
${judge}
#undef quitf
#undef main
namespace setdraft_checker {
#define main setdraft_checker_main
${checker}
#undef main
}
int main(int argc, char* argv[]) {
    if (argc == 5 && std::string(argv[1]) == "--setdraft-checker") return setdraft_checker::setdraft_checker_main(argc - 1, argv + 1);
    if (argc < 4) quitf(_fail, "Missing jury arguments");
    using namespace setdraft_comm;
    const std::string platform = "${platform}";
    std::string raw = read(argv[1]);
    if (platform == "local") currentRound = argc > 4 && std::string(argv[4]) == "2" ? 2 : 1;
    else if (platform == "hydro") { const char* pass = getenv("HYDRO_MULTI_PASS"); currentRound = pass ? atoi(pass) : 1; }
    else {
        currentRound = raw.rfind("${magic} ", 0) == 0 ? 2 : 1;
        if (currentRound == 1) {
            size_t e = raw.find('\\n'); std::istringstream h(raw.substr(0, e)); std::string tag, extra; unsigned long long size;
            if (e == std::string::npos || !(h >> tag >> size) || h >> extra || tag != "${initialMagic}" || size != raw.size() - e - 1) quitf(_fail, "Invalid first-round input envelope");
            raw = raw.substr(e + 1);
        }
    }
    if (currentRound != 1 && currentRound != 2) quitf(_fail, "Unexpected third round");
    std::string folder = platform == "domjudge" ? argv[3] : platform == "local" ? "/jury" : ".";
    nextPath = folder + "/nextpass.in"; originalPath = folder + "/original.in"; outputPath = folder + "/final.out";
    answerPath = platform == "domjudge" ? argv[2] : argv[3];
    if (currentRound == 2) decode(raw); else original = raw;
    write(originalPath, original);
    std::string transcript = folder + "/transcript";
    std::vector<std::string> parameters = {argv[0], originalPath, transcript, answerPath};
    std::vector<char*> pointers; for (auto& v : parameters) pointers.push_back(&v[0]); pointers.push_back(nullptr);
    if (currentRound == 1 || "${config.secondRound}" == std::string("interactive")) {
        // Supervise all testlib exit paths, including quit(), quitp() and a plain return.
        pid_t child = fork();
        if (child < 0) quitf(_fail, "Cannot start communication judge");
        if (child == 0) return setdraft_judge_main(4, pointers.data());
        int status = 0;
        if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status)) quitf(_fail, "Communication judge failed");
        int code = WEXITSTATUS(status);
        if (currentRound == 1 && code == 7) quitf(_fail, "Round one cannot award partial points");
        if (code == 0 && currentRound == 1) {
            std::string expected = original;
            decode(read(nextPath));
            if (original != expected) quitf(_fail, "Handoff changed original private input");
        }
        if (currentRound == 2 && access(nextPath.c_str(), F_OK) == 0) quitf(_fail, "Unexpected third-round handoff");
        _Exit(code);
    }
    registerInteraction(4, pointers.data());
    std::cout.write(secondInput.data(), secondInput.size()); std::cout.flush(); close(STDOUT_FILENO);
    std::string output;
    while (!ouf.eof()) { output += ouf.readChar(); if (output.size() > maximum) quitf(_wa, "Final output too large"); }
    write(outputPath, output);
    if (platform == "local" && argc > 5 && std::string(argv[5]) == "generate") write(answerPath, output);
    pid_t child = fork();
    if (child < 0) quitf(_fail, "Cannot start final checker");
    if (child == 0) { execl(argv[0], argv[0], "--setdraft-checker", originalPath.c_str(), outputPath.c_str(), answerPath.c_str(), (char*)nullptr); _Exit(3); }
    int status = 0; if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status)) quitf(_fail, "Checker failed");
    _Exit(WEXITSTATUS(status));
}
`;
}
