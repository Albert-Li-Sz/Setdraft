export const defaultTextChecker = `#include "testlib.h"
#include <string>
#include <vector>

std::vector<std::string> normalized(InStream& stream) {
    std::vector<std::string> lines;
    std::string line;
    bool lastWasCr = false;
    while (!stream.eof()) {
        char character = stream.readChar();
        if (character == '\\n' && lastWasCr) {
            lastWasCr = false;
            continue;
        }
        lastWasCr = character == '\\r';
        if (lastWasCr) character = '\\n';
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

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    if (normalized(ouf) != normalized(ans)) quitf(_wa, "Output text differs");
    quitf(_ok, "Output text matches");
}
`;

export type CheckerMode = "text" | "custom";

export function effectiveChecker(mode: CheckerMode | undefined, customSource: string): string | undefined {
	if (mode === "text") return defaultTextChecker;
	if (mode === "custom" && customSource.trim()) return customSource;
	return undefined;
}
