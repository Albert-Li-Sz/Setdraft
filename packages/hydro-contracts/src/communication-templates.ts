import type { ProgramLanguage } from "./index.ts";

export function communicationJudgeTemplate(inputMode: "provided" | "empty"): string {
	return `#include "testlib.h"
#include "setdraft_communication.h"
#include <iostream>
#include <string>

int main(int argc, char* argv[]) {
    registerInteraction(argc, argv);
    int challenge = ${inputMode === "provided" ? 'inf.readInt(1, 1000000, "challenge")' : "21"};
    if (communicationRound() == 1) {
        std::cout << "first\\n" << challenge << std::endl;
        long long encoded = ouf.readLong();
        if (encoded != 2LL * challenge) quitf(_wa, "First round encoding is wrong");
        // Explicit information for the judge, and input used by text / Checker round two.
        saveCommunicationHandoff(std::to_string(encoded), "second\\n" + std::to_string(encoded) + "\\n");
        quitf(_ok, "First round accepted");
    }
    long long encoded = std::stoll(communicationHandoff());
    std::cout << "second\\n" << encoded << std::endl;
    long long decoded = ouf.readLong();
    if (decoded != challenge) quitf(_wa, "Second round decoding is wrong");
    quitf(_ok, "Both rounds accepted");
}
`;
}
export function communicationReferenceTemplate(language: ProgramLanguage): string {
	if (language === "python3")
		return `import sys\nphase = sys.stdin.readline().strip()\nvalue = int(sys.stdin.readline())\nprint(value * 2 if phase == "first" else value // 2, flush=True)\n`;
	if (language === "java")
		return `import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        String phase = in.next();\n        long value = in.nextLong();\n        System.out.println(phase.equals("first") ? value * 2 : value / 2);\n        System.out.flush();\n    }\n}\n`;
	return `#include <iostream>\n#include <string>\nint main() {\n    std::string phase; long long value;\n    if (!(std::cin >> phase >> value)) return 1;\n    std::cout << (phase == "first" ? value * 2 : value / 2) << std::endl;\n}\n`;
}
