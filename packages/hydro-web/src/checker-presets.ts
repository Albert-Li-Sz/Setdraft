export interface CheckerPreset {
	id: "ncmp" | "rcmp4" | "rcmp6" | "rcmp9" | "wcmp" | "yesno";
	label: string;
	description: string;
	source: string;
}

function sequenceChecker(readMethod: "readLong" | "readDouble" | "readWord", comparison: string): string {
	return `#include "testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int count = 0;
    while (!ans.seekEof()) {
        if (ouf.seekEof()) quitf(_wa, "Too few output tokens at position %d", count + 1);
        auto expected = ans.${readMethod}();
        auto actual = ouf.${readMethod}();
        if (!(${comparison})) quitf(_wa, "Output token %d differs", count + 1);
        ++count;
    }
    if (!ouf.seekEof()) quitf(_wa, "Extra output after %d tokens", count);
    quitf(_ok, "%d tokens matched", count);
}
`;
}

const yesNoChecker = `#include "testlib.h"
#include <cctype>
#include <string>

std::string normalized(std::string word) {
    for (char& ch : word) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
    return word;
}

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int count = 0;
    while (!ans.seekEof()) {
        if (ouf.seekEof()) quitf(_wa, "Too few output tokens at position %d", count + 1);
        std::string expected = normalized(ans.readWord());
        std::string actual = normalized(ouf.readWord());
        if (expected != "YES" && expected != "NO") quitf(_fail, "Answer token %d is not YES or NO", count + 1);
        if (actual != "YES" && actual != "NO") quitf(_wa, "Output token %d is not YES or NO", count + 1);
        if (expected != actual) quitf(_wa, "Output token %d differs", count + 1);
        ++count;
    }
    if (!ouf.seekEof()) quitf(_wa, "Extra output after %d tokens", count);
    quitf(_ok, "%d YES/NO tokens matched", count);
}
`;

export const checkerPresets: readonly CheckerPreset[] = [
	{
		id: "ncmp",
		label: "ncmp",
		description: "逐项比较有序 64 位整数",
		source: sequenceChecker("readLong", "expected == actual"),
	},
	{
		id: "wcmp",
		label: "wcmp",
		description: "逐项比较有序单词，忽略空白差异",
		source: sequenceChecker("readWord", "expected == actual"),
	},
	{
		id: "rcmp4",
		label: "rcmp4",
		description: "实数绝对或相对误差不超过 10⁻⁴",
		source: sequenceChecker("readDouble", "doubleCompare(expected, actual, 1e-4)"),
	},
	{
		id: "rcmp6",
		label: "rcmp6",
		description: "实数绝对或相对误差不超过 10⁻⁶",
		source: sequenceChecker("readDouble", "doubleCompare(expected, actual, 1e-6)"),
	},
	{
		id: "rcmp9",
		label: "rcmp9",
		description: "实数绝对或相对误差不超过 10⁻⁹",
		source: sequenceChecker("readDouble", "doubleCompare(expected, actual, 1e-9)"),
	},
	{
		id: "yesno",
		label: "yesno",
		description: "逐项比较 YES / NO，忽略大小写",
		source: yesNoChecker,
	},
];
