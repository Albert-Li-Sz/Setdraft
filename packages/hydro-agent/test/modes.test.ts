import { describe, expect, it } from "vitest";
import type { HydroAuthoringProject } from "../src/authoring-project.ts";
import { DockerHydroSandbox } from "../src/sandbox.ts";
import { scoreHydroSubtasks } from "../src/scoring.ts";
import { noInputProject } from "./authoring-fixtures.ts";

const sandbox = new DockerHydroSandbox();

const inputGenerator = `#include "testlib.h"
#include <iostream>
int main(int argc,char** argv){registerGen(argc,argv,1);std::cout<<atoi(argv[1])<<"\\n";}`;
const inputValidator = `#include "testlib.h"
int main(int argc,char** argv){registerValidation(argc,argv);inf.readInt(1,10,"x");inf.readEoln();inf.readEof();}`;

function answerProject(answerMode: "single" | "multi"): HydroAuthoringProject {
	return {
		type: "submit_answer",
		answerMode,
		reference: { language: "python3", code: "print(int(input()) * 2)" },
		oracle: { language: "cpp17", code: "#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<x+x<<'\\n';}" },
		generator: inputGenerator,
		validator: inputValidator,
		cases:
			answerMode === "single"
				? [{ id: "five", purpose: "sample", generatorArgs: ["5"], expectedOutput: "10\n", oracle: true }]
				: [
						{
							id: "five",
							purpose: "sample",
							generatorArgs: ["5"],
							submissionFile: "five.ans",
							expectedOutput: "10\n",
							oracle: true,
						},
						{
							id: "seven",
							purpose: "boundary",
							input: "7\n",
							submissionFile: "seven.ans",
							expectedOutput: "14\n",
							oracle: true,
						},
					],
		invalidInputs: ["0\n", "11\n"],
		wrongPrograms: [
			{ name: "off by one", program: { language: "python3", code: "print(int(input()) * 2 + 1)" }, maxScore: 0 },
		],
		timeLimitMs: 1000,
		memoryLimitMb: 256,
		analysis: "Offline doubled-answer generation with an independently compiled oracle.",
	};
}

function interactiveProject(multiPass: boolean): HydroAuthoringProject {
	const interactor = `#include "testlib.h"
#include <iostream>
#include <cstdio>
#include <cstdlib>
int main(int argc,char** argv){
 registerInteraction(argc,argv);
 int x=inf.readInt(1,10,"secret");
 int pass=std::getenv("HYDRO_MULTI_PASS")?std::atoi(std::getenv("HYDRO_MULTI_PASS")):0;
 ${multiPass ? `if(pass==2){FILE*f=fopen("state.txt","r");int marker=0;if(!f||fscanf(f,"%d",&marker)!=1||marker!=x)quitf(_fail,"state missing");fclose(f);}` : ""}
 std::cout<<x<<std::endl;
 int queries=0;
 while(true){
  std::string op=ouf.readToken();
  if(op=="?"){ouf.readInt();if(++queries>2)quitf(_wa,"query limit");std::cout<<x<<std::endl;continue;}
  if(op!="!")quitf(_wa,"bad command");
  int answer=ouf.readInt();
  if(answer!=x)quitf(_wa,"incorrect answer");
  ${multiPass ? `if(pass==1){FILE*f=fopen("nextpass.in","w");fprintf(f,"%d\\n",x+1);fclose(f);f=fopen("state.txt","w");fprintf(f,"%d\\n",x+1);fclose(f);}` : ""}
  quitf(_ok,"correct");
 }
}`;
	return {
		type: "interactive",
		multiPass: multiPass ? 2 : undefined,
		reference: { language: "python3", code: "x=int(input()); print('!',x,flush=True)" },
		oracle: {
			language: "cpp17",
			code: '#include <iostream>\nint main(){int x;std::cin>>x;std::cout<<"! "<<x<<std::endl;}',
		},
		generator: inputGenerator,
		validator: inputValidator,
		interactor,
		queryLimitProbe: { language: "python3", code: "input()\nfor _ in range(3):\n print('? 1',flush=True)\n input()" },
		cases: [{ id: "secret", purpose: "sample", generatorArgs: ["3"], oracle: true }],
		invalidInputs: ["0\n"],
		wrongPrograms: [
			{ name: "constant answer", program: { language: "python3", code: "input(); print('! 0',flush=True)" } },
		],
		timeLimitMs: 1000,
		memoryLimitMb: 256,
		analysis: "Interactive secret reply, with query limit, timeout and optional stateful second pass.",
	};
}

describe("Hydro judging modes", () => {
	it("calculates sum, min, max and dependent subtask scores", () => {
		const subtasks = [
			{ id: 1, type: "sum" as const, score: 40, cases: [{ caseId: "a" }, { caseId: "b" }] },
			{ id: 2, type: "min" as const, score: 30, cases: [{ caseId: "a" }, { caseId: "b" }] },
			{ id: 3, type: "max" as const, score: 30, dependsOn: [1], cases: [{ caseId: "a" }, { caseId: "b" }] },
		];
		expect(scoreHydroSubtasks(subtasks, { a: 100, b: 50 })).toBe(45);
		expect(scoreHydroSubtasks(subtasks, { a: 100, b: 100 })).toBe(100);
		expect(
			scoreHydroSubtasks([{ id: 1, type: "sum", score: 19, cases: [{ caseId: "a" }, { caseId: "b" }] }], {
				a: 100,
				b: 0,
			}),
		).toBe(9.5);
	}, 90_000);

	it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
		"verifies testlib partial scores",
		async () => {
			const project: HydroAuthoringProject = {
				...noInputProject,
				checker: `#include "testlib.h"
int main(int argc,char** argv){registerTestlibCmd(argc,argv);int a=ouf.readInt();ouf.readEoln();ouf.readEof();if(a==42)quitf(_ok,"correct");if(a==41)quitp(0.5,"half");quitf(_wa,"wrong");}`,
				checkerProbes: [
					{ caseId: "empty", output: "42\n", accept: true, description: "full" },
					{ caseId: "empty", output: "41\n", accept: false, score: 50, description: "partial" },
					{ caseId: "empty", output: "0\n", accept: false, description: "zero" },
				],
				wrongPrograms: [{ ...noInputProject.wrongPrograms[0], maxScore: 50 }],
			};
			const report = await sandbox.verifyProject?.(project);
			expect(report?.success, JSON.stringify(report?.checks.filter((item) => !item.passed))).toBe(true);
			expect(report?.wrongScores?.["wrong constant"]?.empty).toBe(50);
		},
		90_000,
	);

	for (const mode of ["single", "multi"] as const) {
		it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
			`verifies ${mode} answer submissions`,
			async () => {
				const report = await sandbox.verifyProject?.(answerProject(mode));
				expect(report?.success, JSON.stringify(report?.checks.filter((item) => !item.passed))).toBe(true);
				expect(
					report?.checks.some(
						(item) => item.stage === (mode === "multi" ? "submission-zip" : "submission-single") && item.passed,
					),
				).toBe(true);
			},
			90_000,
		);
	}

	for (const multiPass of [false, true]) {
		it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
			`verifies interactive ${multiPass ? "multi-pass" : "single-pass"} with negatives`,
			async () => {
				const report = await sandbox.verifyProject?.(interactiveProject(multiPass));
				expect(report?.success, JSON.stringify(report?.checks.filter((item) => !item.passed))).toBe(true);
				for (const stage of ["interaction-timeout", "interaction-query-limit", "wrong-program-killed"])
					expect(
						report?.checks.some((item) => item.stage === stage && item.passed),
						stage,
					).toBe(true);
			},
			90_000,
		);
	}
});
