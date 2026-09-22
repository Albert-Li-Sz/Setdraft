import { describe, expect, it } from "vitest";
import {
	algorithmValidationPresentation,
	apiUrl,
	normalizeApiOrigin,
	pageFromHash,
	readAgentRunList,
	readAiConfiguration,
	runDisplayTitle,
} from "../src/platform.ts";

describe("platform navigation and API configuration", () => {
	it("maps every header destination to a real page", () => {
		expect(pageFromHash("#workspace")).toBe("workspace");
		expect(pageFromHash("#runs")).toBe("runs");
		expect(pageFromHash("#settings")).toBe("settings");
		expect(pageFromHash("#unknown")).toBe("workspace");
	});

	it("builds same-origin and configured API URLs", () => {
		expect(apiUrl("", "/health")).toBe("/api/health");
		expect(apiUrl("http://127.0.0.1:4321/", "/runs")).toBe("http://127.0.0.1:4321/api/runs");
		expect(normalizeApiOrigin(" https://api.example.com/ ")).toBe("https://api.example.com");
		expect(() => normalizeApiOrigin("https://user:secret@example.com")).toThrow("不能包含用户名或密码");
	});

	it("parses task history and extracts the requested problem title", () => {
		const runs = readAgentRunList({
			runs: [
				{
					id: "run-1",
					status: "succeeded",
					title: "A + B",
					sourcePreview: "制题请求 A + B",
					createdAt: "2026-09-22T07:00:00.000Z",
					updatedAt: "2026-09-22T07:01:00.000Z",
					lastEventSequence: 3,
				},
			],
		});
		expect(runs).toHaveLength(1);
		expect(runDisplayTitle(runs[0])).toBe("A + B");
		expect(
			runDisplayTitle({
				...runs[0],
				source: "- 建议题目名称：A + B\n\n## 用户提供的题面\n\n# 三连击\n",
			}),
		).toBe("三连击");
		expect(readAgentRunList({ runs: [{ id: 42 }] })).toEqual([]);
	});

	it("parses AI configuration metadata without accepting a returned API key", () => {
		const configuration = readAiConfiguration({
			configured: true,
			provider: "openai",
			modelId: "gpt-test",
			contextWindow: 262_144,
			maxTokens: 32_768,
			apiKeyConfigured: true,
			providers: [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-test", name: "GPT Test" }] }],
		});
		expect(configuration).toMatchObject({
			configured: true,
			provider: "openai",
			modelId: "gpt-test",
			contextWindow: 262_144,
			maxTokens: 32_768,
		});
		expect(readAiConfiguration({ ...configuration, apiKey: "must-not-be-here" })).toBeUndefined();
		expect(readAiConfiguration({ ...configuration, contextWindow: 1.5 })).toBeUndefined();
	});

	it("marks algorithm and data validation as passed from verified authoring evidence", () => {
		const run = readAgentRunList({
			runs: [
				{
					id: "verified-run",
					status: "succeeded",
					title: "Verified",
					sourcePreview: "Verified",
					createdAt: "2026-09-22T07:00:00.000Z",
					updatedAt: "2026-09-22T07:01:00.000Z",
					lastEventSequence: 4,
					artifact: {
						slug: "verified",
						report: { valid: true, issues: [] },
						authoring: {
							verificationId: "evidence-1",
							success: true,
							testCases: 12,
							generatedCases: 8,
							oracleCases: 12,
							validatorNegativeCases: 4,
							checker: "default",
							checkerProbes: 0,
							wrongPrograms: 2,
						},
					},
				},
			],
		})[0];
		const presentation = algorithmValidationPresentation(run, {
			available: true,
			image: "sandbox",
			message: "Linux 沙箱已就绪",
		});
		expect(presentation.className).toBe("passed");
		expect(presentation.message).toContain("12 个测试点验证通过");
		expect(
			algorithmValidationPresentation(undefined, {
				available: true,
				image: "sandbox",
				message: "Linux 沙箱已就绪",
			}),
		).toEqual({
			className: "pending",
			message: "Linux 沙箱已就绪，运行 Pi Agent 后开始验证",
		});
	});
});
