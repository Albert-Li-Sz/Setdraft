import { describe, expect, it } from "vitest";
import { groupAuthoringFailures } from "../src/failure-summary.ts";

describe("groupAuthoringFailures", () => {
	it("collapses the same compiler cause across cases and line numbers", () => {
		const failures = groupAuthoringFailures([
			{
				stage: "compile:validator",
				caseId: "small",
				passed: false,
				message: "/work/validator/main.cpp:12:3: error: ambiguous readLong",
			},
			{
				stage: "compile:validator",
				caseId: "stress",
				passed: false,
				message: "/work/validator/main.cpp:19:8: error: ambiguous readLong",
			},
			{ stage: "validator-negative", caseId: "bad", passed: false, message: "invalid input was accepted" },
		]);
		expect(failures).toHaveLength(2);
		expect(failures[0]).toMatchObject({ stage: "compile:validator", count: 2, caseIds: ["small", "stress"] });
	});
});
