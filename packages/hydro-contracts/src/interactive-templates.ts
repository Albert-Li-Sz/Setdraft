export function interactorTemplate(inputMode: "provided" | "empty"): string {
	return `#include "testlib.h"
#include <iostream>

int main(int argc, char* argv[]) {
    registerInteraction(argc, argv);
    ${inputMode === "provided" ? 'int challenge = inf.readInt(1, 1000000, "challenge");' : 'if (!inf.eof()) quitf(_fail, "Expected an empty input file");\n    int challenge = 21;'}
    std::cout << challenge << std::endl;
    long long answer = ouf.readLong(-2000000LL, 2000000LL, "answer");
    if (answer != 2LL * challenge) quitf(_wa, "Expected twice the challenge");
    quitf(_ok, "Correct answer");
}
`;
}

export const interactiveReferenceTemplate = `#include <iostream>

int main() {
    long long challenge;
    if (!(std::cin >> challenge)) return 1;
    std::cout << challenge * 2 << std::endl;
    return 0;
}
`;
