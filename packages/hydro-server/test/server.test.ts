import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHydroStatement } from "@hydro-problem-make/authoring/statement";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { ManualProjectStore, parseGeneratorScript } from "../src/manual-projects.ts";
import { cppLanguages, runManualSandbox } from "../src/manual-sandbox.ts";
import { createHydroServer } from "../src/server.ts";

let root: string;
let store: ManualProjectStore;
let chat: ChatService;
let server: ReturnType<typeof createHydroServer>;
let origin: string;

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["image", "inspect", "hydro-problem-make/sandbox:local"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
	const response = await fetch(`${origin}/api${path}`, init);
	return { status: response.status, body: (await response.json()) as T };
}

async function createProject(): Promise<{ id: string }> {
	const result = await json<{ id: string }>("/projects", { method: "POST" });
	expect(result.status).toBe(201);
	return result.body;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-manual-api-"));
	store = new ManualProjectStore({ root });
	chat = new ChatService({
		root,
		configPath: join(root, "ai-config.json"),
		client: async ({ onDelta }) => {
			onDelta("测试回复");
			return "测试回复";
		},
	});
	server = createHydroServer({ projects: store, chat });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});

describe("manual project API", () => {
	it("accepts quoted Gen arguments but rejects shell execution syntax", () => {
		expect(parseGeneratorScript("# seed\ngen large 1000000 100\ngen 'two words' 7 # comment")).toEqual([
			["large", "1000000", "100"],
			["two words", "7"],
		]);
		for (const script of ["gen 1 | cat", "gen 1 > 1.in", "gen $HOME", "echo 1", "gen 'unfinished"]) {
			expect(() => parseGeneratorScript(script), script).toThrow();
		}
	});
	it("creates, saves and lists a server-persistent draft", async () => {
		const project = await createProject();
		const updated = await json<{ title: string; revision: number }>(`/projects/${project.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "A + B",
				slug: "a-plus-b",
				statement: "# A + B",
				samples: [{ input: "1 2", output: "3" }],
			}),
		});
		expect(updated.status).toBe(200);
		expect(updated.body).toMatchObject({ title: "A + B", revision: 1 });
		expect(
			(await json<{ projects: Array<{ id: string }> }>("/projects")).body.projects.map((item) => item.id),
		).toContain(project.id);
		expect(
			(
				await json<unknown>("/problems/archive", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(404);
	});

	it("saves every supported C++ standard and rejects unknown compiler modes", async () => {
		const project = await createProject();
		const initial = (
			await json<{ reference: { language: string }; generatorStandard: string }>(`/projects/${project.id}`)
		).body;
		expect(initial.reference.language).toBe("cpp17");
		expect(initial.generatorStandard).toBe("cpp17");
		for (const language of cppLanguages) {
			const updated = await json<{
				reference: { language: string };
				oracle: { language: string };
				generatorStandard: string;
				checkerStandard: string;
				validatorStandard: string;
			}>(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					reference: { language, code: "int main(){return 0;}" },
					oracle: { language, code: "int main(){return 0;}" },
					generatorStandard: language,
					checkerStandard: language,
					validatorStandard: language,
				}),
			});
			expect(updated.status).toBe(200);
			expect(updated.body).toMatchObject({
				reference: { language },
				oracle: { language },
				generatorStandard: language,
				checkerStandard: language,
				validatorStandard: language,
			});
		}
		const invalid = await json<{ message: string }>(`/projects/${project.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ generatorStandard: "cpp99" }),
		});
		expect(invalid.status).toBe(400);
		expect(invalid.body.message).toContain("C++11");
	});

	it("streams and pairs input, output and answer files", async () => {
		const project = await createProject();
		for (const [name, content] of [
			["1.in", "1 2\n"],
			["1.ans", "3\n"],
			["2.in", "4 5\n"],
		]) {
			const response = await fetch(`${origin}/api/projects/${project.id}/files/${name}`, {
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: content,
			});
			expect(response.status, await response.clone().text()).toBe(200);
		}
		const snapshot = (
			await json<{ cases: Array<{ inputFile: string; outputFile?: string }>; orphanOutputs: string[] }>(
				`/projects/${project.id}`,
			)
		).body;
		expect(snapshot.cases).toMatchObject([{ inputFile: "1.in", outputFile: "1.ans" }, { inputFile: "2.in" }]);
		expect(snapshot.orphanOutputs).toEqual([]);
		const file = await fetch(`${origin}/api/projects/${project.id}/files/1.in`);
		expect(await file.text()).toBe("1 2\n");
	});

	it("adds exact text cases with optional empty output and numbers after uploaded files", async () => {
		const project = await createProject();
		await json(`/projects/${project.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				subtasks: [
					{ id: 1, type: "sum", score: 50 },
					{ id: 2, type: "sum", score: 50 },
				],
			}),
		});
		for (const name of ["1.in", "2.in"]) {
			expect(
				(
					await fetch(`${origin}/api/projects/${project.id}/files/${name}`, {
						method: "PUT",
						headers: { "content-type": "application/octet-stream" },
						body: "old\n",
					})
				).status,
			).toBe(200);
		}
		const add = (value: unknown) =>
			json<{
				inputFile: string;
				outputFile?: string;
				project: { revision: number; cases: Array<{ inputFile: string; subtaskId: number }> };
				message?: string;
			}>(`/projects/${project.id}/cases`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value),
			});
		const custom = await add({ input: "7 8\n", output: "15\n", subtaskId: 2 });
		expect(custom.status).toBe(201);
		expect(custom.body).toMatchObject({ inputFile: "3.in", outputFile: "3.out" });
		expect(custom.body.project.cases.find((item) => item.inputFile === "3.in")?.subtaskId).toBe(2);
		expect(await (await fetch(`${origin}/api/projects/${project.id}/files/3.in`)).text()).toBe("7 8\n");
		expect(await (await fetch(`${origin}/api/projects/${project.id}/files/3.out`)).text()).toBe("15\n");
		const empty = await add({ input: "" });
		expect(empty.body).toMatchObject({ inputFile: "4.in" });
		expect(empty.body.outputFile).toBeUndefined();
		expect((await fetch(`${origin}/api/projects/${project.id}/files/4.in`)).headers.get("content-length")).toBe("0");
		const whitespace = await add({ name: "spaces.in", input: " \n\t", output: "" });
		expect(whitespace.body).toMatchObject({ inputFile: "spaces.in", outputFile: "spaces.out" });
		expect(await (await fetch(`${origin}/api/projects/${project.id}/files/spaces.in`)).text()).toBe(" \n\t");
		expect((await fetch(`${origin}/api/projects/${project.id}/files/spaces.out`)).headers.get("content-length")).toBe(
			"0",
		);
		const generatedOutput = await add({ input: "9 10\n" });
		expect(generatedOutput.body.inputFile).toBe("5.in");
		expect(generatedOutput.body.outputFile).toBeUndefined();
		const before = generatedOutput.body.project.revision;
		const duplicate = await add({ name: "3.in", input: "overwrite" });
		expect(duplicate.status).toBe(409);
		expect(duplicate.body.message).toContain("已存在");
		const invalid = await add({ name: "broken.in", input: "x", output: 1 });
		expect(invalid.status).toBe(400);
		const longName = await add({ name: `${"x".repeat(252)}.in`, input: "x" });
		expect(longName.status).toBe(400);
		const tooLarge = await add({ name: "large.in", input: "界".repeat(400_000) });
		expect(tooLarge.status).toBe(413);
		expect((await json<{ revision: number }>(`/projects/${project.id}`)).body.revision).toBe(before);
		expect((await fetch(`${origin}/api/projects/${project.id}/files/broken.in`)).status).toBe(404);
		expect((await fetch(`${origin}/api/projects/${project.id}/files/large.in`)).status).toBe(404);
		expect(await (await fetch(`${origin}/api/projects/${project.id}/files/3.in`)).text()).toBe("7 8\n");
	});

	it("rolls back both text files when saving the case fails", async () => {
		const project = await createProject();
		const save = Reflect.get(store, "save") as (value: unknown) => Promise<void>;
		Reflect.set(store, "save", async () => {
			throw new Error("simulated save failure");
		});
		try {
			await expect(store.addTextCase(project.id, { name: "retry.in", input: "x", output: "y" })).rejects.toThrow(
				"simulated save failure",
			);
		} finally {
			Reflect.set(store, "save", save);
		}
		expect((await fetch(`${origin}/api/projects/${project.id}/files/retry.in`)).status).toBe(404);
		expect((await fetch(`${origin}/api/projects/${project.id}/files/retry.out`)).status).toBe(404);
		expect((await json<{ revision: number; cases: unknown[] }>(`/projects/${project.id}`)).body).toMatchObject({
			revision: 0,
			cases: [],
		});
	});

	it("streams faux-provider AI replies and persists the conversation", async () => {
		const configured = await json<{ configured: boolean; apiKey?: string }>("/ai/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "openai-completions",
				modelId: "fake-model",
				apiKey: "fake-key",
				contextWindow: 8192,
				maxTokens: 1024,
			}),
		});
		expect(configured.body.configured).toBe(true);
		expect(configured.body.apiKey).toBeUndefined();
		const created = await json<{ id: string }>("/chats", { method: "POST" });
		const response = await fetch(`${origin}/api/chats/${created.body.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "你好" }),
		});
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader!.read();
		const decoder = new TextDecoder();
		let stream = decoder.decode(first.value, { stream: true });
		expect(stream).toContain("event: start");
		for (;;) {
			const next = await reader!.read();
			if (next.done) break;
			stream += decoder.decode(next.value, { stream: true });
		}
		stream += decoder.decode();
		expect([...stream.matchAll(/^event: (start|delta|done)$/gmu)].map((match) => match[1])).toEqual([
			"start",
			"delta",
			"done",
		]);
		expect(stream).toContain('"content":"你好"');
		expect(
			(await json<{ messages: Array<{ content: string }> }>(`/chats/${created.body.id}`)).body.messages.map(
				(item) => item.content,
			),
		).toEqual(["你好", "测试回复"]);
	});

	it("accepts an image-only chat message and serves its saved attachment", async () => {
		await json("/ai/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "openai-completions",
				modelId: "vision",
				apiKey: "fake",
				contextWindow: 8192,
				maxTokens: 1024,
			}),
		});
		const created = await json<{ id: string }>("/chats", { method: "POST" });
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
		const response = await fetch(`${origin}/api/chats/${created.body.id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "", images: [{ name: "pixel.png", mimeType: "image/png", data: png }] }),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("event: done");
		const conversation = (
			await json<{ messages: Array<{ images?: Array<{ id: string }> }> }>(`/chats/${created.body.id}`)
		).body;
		const imageId = conversation.messages[0].images?.[0].id;
		expect(imageId).toBeTruthy();
		expect(JSON.stringify(conversation)).not.toContain(png);
		const image = await fetch(`${origin}/api/chats/${created.body.id}/images/${imageId}`);
		expect(image.status).toBe(200);
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(png, "base64"));
		expect((await fetch(`${origin}/api/chats/${created.body.id}/images/unknown`)).status).toBe(404);
	});

	it("manages multiple AI profiles and switches a continuing chat through the API", async () => {
		const first = await json<{
			defaultProfileId: string;
			profiles: Array<{ id: string; modelId: string; apiKeyConfigured: boolean }>;
		}>("/ai/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "模型 A",
				provider: "openai-completions",
				modelId: "model-a",
				apiKey: "key-a",
				contextWindow: 8192,
				maxTokens: 1024,
			}),
		});
		expect(first.status).toBe(200);
		const firstId = first.body.profiles[0].id;
		const second = await json<typeof first.body>("/ai/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "模型 B",
				provider: "anthropic-messages",
				modelId: "model-b",
				apiKey: "key-b",
				contextWindow: 8192,
				maxTokens: 1024,
			}),
		});
		const secondId = second.body.profiles[1].id;
		expect(second.body.defaultProfileId).toBe(firstId);
		expect(JSON.stringify(second.body)).not.toContain("key-a");
		expect(JSON.stringify(second.body)).not.toContain("key-b");
		const selected = await json<typeof first.body>("/ai/config/default", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profileId: secondId }),
		});
		expect(selected.body.defaultProfileId).toBe(secondId);
		const created = await json<{ id: string }>("/chats", { method: "POST" });
		for (const [message, profileId] of [
			["第一轮", firstId],
			["第二轮", secondId],
		]) {
			const response = await fetch(`${origin}/api/chats/${created.body.id}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message, profileId }),
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("event: done");
		}
		const conversation = (
			await json<{
				profileId: string;
				messages: Array<{ content: string; modelId?: string }>;
			}>(`/chats/${created.body.id}`)
		).body;
		expect(conversation.profileId).toBe(secondId);
		expect(conversation.messages.map((item) => item.content)).toEqual(["第一轮", "测试回复", "第二轮", "测试回复"]);
		expect(conversation.messages.filter((item) => item.modelId).map((item) => item.modelId)).toEqual([
			"model-a",
			"model-b",
		]);
		const removed = await json<typeof first.body>(`/ai/config/${firstId}`, { method: "DELETE" });
		expect(removed.body.profiles).toHaveLength(1);
		expect(removed.body.profiles[0].id).toBe(secondId);
		expect((await json<{ messages: unknown[] }>(`/chats/${created.body.id}`)).body.messages).toHaveLength(4);
	});

	it.skipIf(!dockerAvailable)(
		"compiles reference, oracle, Gen, SPJ and validator with their selected GCC 15.2 standards",
		async () => {
			const generated = await runManualSandbox({
				mode: "generate",
				stage: join(root, "cpp-standards-generate"),
				image: "hydro-problem-make/sandbox:local",
				reference: {
					language: "cpp11",
					code: '#include <iostream>\n#if __cplusplus != 201103L\n#error wrong C++ standard\n#endif\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
				},
				oracle: {
					language: "cpp14",
					code: '#include <iostream>\n#if __cplusplus != 201402L\n#error wrong C++ standard\n#endif\nint main(){int a,b;std::cin>>a>>b;auto sum=[](auto x,auto y){return x+y;};std::cout<<sum(a,b)<<"\\n";}',
				},
				generator:
					'#include "testlib.h"\n#include <cstdio>\n#if __cplusplus != 201703L\n#error wrong C++ standard\n#endif\nint main(int argc,char**argv){registerGen(argc,argv,1);printf("1 2\\n");}',
				generatorStandard: "cpp17",
				commands: [[]],
				startNumber: 1,
				checker:
					'#include "testlib.h"\n#if __cplusplus != 202002L\n#error wrong C++ standard\n#endif\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);int a=ans.readInt(),b=ouf.readInt();if(a!=b)quitf(_wa,"different");quitf(_ok,"accepted");}',
				checkerStandard: "cpp20",
				validator:
					'#include "testlib.h"\n#if __cplusplus != 202400L\n#error wrong C++ standard\n#endif\nint main(int argc,char**argv){registerValidation(argc,argv);inf.readInt();inf.readSpace();inf.readInt();inf.readEoln();inf.readEof();}',
				validatorStandard: "cpp26",
				timeLimitMs: 1000,
				memoryLimitMb: 256,
				maxFileBytes: 1024 * 1024,
			});
			expect(generated.success, JSON.stringify(generated.checks)).toBe(true);
			expect(generated.generatedCount).toBe(1);
			expect(generated.oracleCount).toBe(1);
			const inputPath = join(root, "cpp-standards-generate", "generated", "1.in");
			const finalized = await runManualSandbox({
				mode: "finalize",
				stage: join(root, "cpp-standards-finalize"),
				image: "hydro-problem-make/sandbox:local",
				reference: {
					language: "cpp23",
					code: '#include <iostream>\n#if __cplusplus != 202302L\n#error wrong C++ standard\n#endif\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
				},
				generatorStandard: "cpp17",
				checkerStandard: "cpp17",
				validatorStandard: "cpp17",
				cases: [{ id: "1", inputPath, outputName: "1.out" }],
				timeLimitMs: 1000,
				memoryLimitMb: 256,
				maxFileBytes: 1024 * 1024,
			});
			expect(finalized.success, JSON.stringify(finalized.checks)).toBe(true);
		},
		120_000,
	);

	it.skipIf(!dockerAvailable)(
		"finalizes a real Docker-verified problem and preserves its historical release",
		async () => {
			const project = await createProject();
			const referenceCode =
				"#include <iostream>\n#if __cplusplus != 202302L\n#error wrong C++ standard\n#endif\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<'\\n';}";
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "A + B",
					slug: "a-plus-b",
					statement: "# A + B\n\n计算和。",
					reference: {
						language: "cpp23",
						code: referenceCode,
					},
					samples: [{ input: "1 2\n", output: "3\n" }],
				}),
			});
			const added = await json<{ inputFile: string }>(`/projects/${project.id}/cases`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: "1 2\n" }),
			});
			expect(added.status).toBe(201);
			expect(added.body.inputFile).toBe("1.in");
			const finished = await json<{ report: { success: boolean }; release?: { id: string } }>(
				`/projects/${project.id}/finalize`,
				{ method: "POST" },
			);
			expect(finished.status).toBe(200);
			expect(finished.body.report.success).toBe(true);
			const releaseId = finished.body.release?.id;
			expect(releaseId).toBeTruthy();
			const hydro = await fetch(`${origin}/api/releases/${releaseId}/hydro`);
			expect(hydro.status).toBe(200);
			expect(Buffer.from(await hydro.arrayBuffer()).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
			const source = await fetch(`${origin}/api/releases/${releaseId}/source`);
			expect(source.status).toBe(200);
			const hydroPath = (await store.releaseFile(releaseId!, "hydro")).path;
			const sourcePath = (await store.releaseFile(releaseId!, "source")).path;
			expect(() => execFileSync("unzip", ["-t", hydroPath], { stdio: "ignore" })).not.toThrow();
			expect(() => execFileSync("unzip", ["-t", sourcePath], { stdio: "ignore" })).not.toThrow();
			expect(execFileSync("unzip", ["-p", hydroPath, "a-plus-b/problem_zh.md"]).toString("utf8")).toBe(
				formatHydroStatement({ statement: "# A + B\n\n计算和。", samples: [{ input: "1 2\n", output: "3\n" }] }),
			);
			const manifest = JSON.parse(
				execFileSync("unzip", ["-p", sourcePath, "a-plus-b.authoring/manifest.json"]).toString("utf8"),
			) as { testlibCommit: string; toolchain: { cpp: string }; languages: { reference: string } };
			expect(manifest.testlibCommit).toBeTruthy();
			expect(manifest.toolchain.cpp).toBe("GCC 15.2.0");
			expect(manifest.languages.reference).toBe("cpp23");
			expect(
				(await json<{ releases: Array<{ id: string }> }>("/releases")).body.releases.map((item) => item.id),
			).toContain(releaseId);
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					statement: "# Modified",
					reference: { language: "cpp17", code: "int main(){return 1;}" },
				}),
			});
			expect((await fetch(`${origin}/api/releases/${releaseId}/hydro`)).status).toBe(200);
			expect(await store.releaseReference(releaseId!)).toEqual({ language: "cpp23", code: referenceCode });
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createHydroServer({
				projects: store,
				chat,
				liveVerifier: {
					status: () => ({ configured: true, message: "test adapter" }),
					verify: async (request) => {
						expect(request.releaseId).toBe(releaseId);
						expect(request.reference.code).toBe(referenceCode);
						return {
							success: true,
							startedAt: "2026-01-01T00:00:00.000Z",
							finishedAt: "2026-01-01T00:00:01.000Z",
							import: { success: true, message: "imported" },
							reference: { name: "reference", verdict: "AC", score: 100, accepted: true },
							wrongPrograms: [],
							message: "Hydro verified",
						};
					},
				},
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const live = await json<{ success: boolean }>(`/releases/${releaseId}/live-verify`, { method: "POST" });
			expect(live.status).toBe(200);
			expect(live.body.success).toBe(true);
			expect((await store.release(releaseId!)).liveVerification?.reference.verdict).toBe("AC");
		},
		120_000,
	);

	it.skipIf(!dockerAvailable)(
		"finalizes an explicitly empty input and empty answer from the text form",
		async () => {
			const project = await createProject();
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Empty IO",
					slug: "empty-io",
					statement: "# Empty IO\n\nNo input or output.",
					reference: { language: "cpp17", code: "int main() {}" },
				}),
			});
			const added = await json<{ inputFile: string; outputFile: string }>(`/projects/${project.id}/cases`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: "", output: "" }),
			});
			expect(added.body).toMatchObject({ inputFile: "1.in", outputFile: "1.out" });
			const finalized = await json<{ release?: { id: string }; report: { success: boolean } }>(
				`/projects/${project.id}/finalize`,
				{ method: "POST" },
			);
			expect(finalized.body.report.success).toBe(true);
			expect(finalized.body.release?.id).toBeTruthy();
			const archive = (await store.releaseFile(finalized.body.release!.id, "hydro")).path;
			expect(execFileSync("unzip", ["-p", archive, "empty-io/testdata/1.in"]).byteLength).toBe(0);
			expect(execFileSync("unzip", ["-p", archive, "empty-io/testdata/1.out"]).byteLength).toBe(0);
		},
		120_000,
	);

	it.skipIf(!dockerAvailable)(
		"compiles testlib Gen, numbers after manual files and atomically replaces generated cases",
		async () => {
			const project = await createProject();
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Sum Gen",
					slug: "sum-gen",
					statement: "# Sum Gen\n\n求和。",
					reference: { language: "python3", code: "a,b=map(int,input().split());print(a+b)" },
					oracle: {
						language: "cpp17",
						code: '#include <cstdio>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}',
					},
					generatorSource:
						'#include "testlib.h"\n#include <cstdio>\nint main(int argc,char**argv){registerGen(argc,argv,1);printf("%s %s\\n",argv[1],argv[2]);}',
					generatorScript: "gen 5 6\ngen 7 8",
					validatorSource:
						'#include "testlib.h"\nint main(int argc,char**argv){registerValidation(argc,argv);inf.readInt();inf.readSpace();inf.readInt();inf.readEoln();inf.readEof();}',
				}),
			});
			for (const name of ["1.in", "2.in"]) {
				const response = await fetch(`${origin}/api/projects/${project.id}/files/${name}`, {
					method: "PUT",
					headers: { "content-type": "application/octet-stream" },
					body: "1 2\n",
				});
				expect(response.status).toBe(200);
			}
			const generated = await json<{
				project: { cases: Array<{ inputFile: string; origin: string }> };
				report: { success: boolean; generatedCount: number; oracleCount: number };
			}>(`/projects/${project.id}/generate`, { method: "POST" });
			expect(generated.status, JSON.stringify(generated.body)).toBe(200);
			expect(generated.body.report).toMatchObject({
				mode: "generate",
				success: true,
				generatedCount: 2,
				oracleCount: 2,
			});
			expect(generated.body.project.cases.map((item) => item.inputFile)).toEqual(["1.in", "2.in", "3.in", "4.in"]);
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ generatorScript: "gen 9 10" }),
			});
			const stale = await json<{ message: string }>(`/projects/${project.id}/finalize`, { method: "POST" });
			expect(stale.status).toBe(422);
			expect(stale.body.message).toContain("重新生成");
			const regenerated = await json<{
				project: { cases: Array<{ inputFile: string }> };
				report: { success: boolean };
			}>(`/projects/${project.id}/generate`, { method: "POST" });
			expect(regenerated.body.report.success).toBe(true);
			expect(regenerated.body.project.cases.map((item) => item.inputFile)).toEqual(["1.in", "2.in", "3.in"]);
			expect((await fetch(`${origin}/api/projects/${project.id}/files/4.in`)).status).toBe(404);
			const colliding = await fetch(`${origin}/api/projects/${project.id}/files/3.in`, {
				method: "PUT",
				headers: { "content-type": "application/octet-stream" },
				body: "1 1\n",
			});
			expect(colliding.status).toBe(200);
			expect(await (await fetch(`${origin}/api/projects/${project.id}/files/3.in?origin=manual`)).text()).toBe(
				"1 1\n",
			);
			expect(await (await fetch(`${origin}/api/projects/${project.id}/files/3.in?origin=generated`)).text()).toBe(
				"9 10\n",
			);
			const conflicted = await json<{ message: string }>(`/projects/${project.id}/finalize`, { method: "POST" });
			expect(conflicted.status).toBe(422);
			expect(conflicted.body.message).toContain("重新生成");
			const renumbered = await json<{
				project: { cases: Array<{ inputFile: string }> };
				report: { success: boolean };
			}>(`/projects/${project.id}/generate`, { method: "POST" });
			expect(renumbered.body.report.success).toBe(true);
			expect(renumbered.body.project.cases.map((item) => item.inputFile)).toEqual(["1.in", "2.in", "3.in", "4.in"]);
			const duplicateGenerated = await json<{ message: string }>(`/projects/${project.id}/cases`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "4.in", input: "collision" }),
			});
			expect(duplicateGenerated.status).toBe(409);
			expect(duplicateGenerated.body.message).toContain("已存在");
			const added = await json<{ inputFile: string }>(`/projects/${project.id}/cases`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: "2 3\n" }),
			});
			expect(added.body.inputFile).toBe("5.in");
			const needsRerun = await json<{ message: string }>(`/projects/${project.id}/finalize`, { method: "POST" });
			expect(needsRerun.status).toBe(422);
			expect(needsRerun.body.message).toContain("重新生成");
			const rerun = await json<{
				project: { cases: Array<{ inputFile: string }> };
				report: { success: boolean };
			}>(`/projects/${project.id}/generate`, { method: "POST" });
			expect(rerun.body.report.success).toBe(true);
			expect(rerun.body.project.cases.map((item) => item.inputFile)).toEqual([
				"1.in",
				"2.in",
				"3.in",
				"5.in",
				"6.in",
			]);
		},
		120_000,
	);

	it.skipIf(!dockerAvailable)(
		"accepts equivalent uploaded answers with a C++ testlib SPJ and rejects a broken checker",
		async () => {
			const project = await createProject();
			const checker =
				'#include "testlib.h"\n#include <cmath>\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);double a=ans.readDouble(),b=ouf.readDouble();if(std::fabs(a-b)>1e-9)quitf(_wa,"wrong answer");quitf(_ok,"accepted");}';
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Sum SPJ",
					slug: "sum-spj",
					statement: "# Sum SPJ\n\n求和。",
					reference: { language: "python3", code: "a,b=map(int,input().split());print(a+b)" },
					checkerSource: checker,
				}),
			});
			for (const [name, body] of [
				["1.in", "1 2\n"],
				["1.out", "3.0\n"],
			]) {
				expect(
					(
						await fetch(`${origin}/api/projects/${project.id}/files/${name}`, {
							method: "PUT",
							headers: { "content-type": "application/octet-stream" },
							body,
						})
					).status,
				).toBe(200);
			}
			const passed = await json<{
				release?: { id: string };
				report: { success: boolean; checks: Array<{ stage: string; passed: boolean }> };
			}>(`/projects/${project.id}/finalize`, { method: "POST" });
			expect(passed.body.report.success).toBe(true);
			expect(passed.body.report.checks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ stage: "answer", passed: true }),
					expect.objectContaining({ stage: "checker-negative:value", passed: true }),
				]),
			);
			expect(passed.body.release?.id).toBeTruthy();
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					checkerSource:
						'#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);ans.readInt();ouf.readInt();quitf(_ok,"always okay");}',
				}),
			});
			await fetch(`${origin}/api/projects/${project.id}/files/1.out`, { method: "DELETE" });
			const rejected = await json<{
				release?: { id: string };
				report: { success: boolean; checks: Array<{ stage: string; passed: boolean }> };
			}>(`/projects/${project.id}/finalize`, { method: "POST" });
			expect(rejected.body.report.success).toBe(false);
			expect(rejected.body.release).toBeUndefined();
			expect(rejected.body.report.checks).toEqual(
				expect.arrayContaining([expect.objectContaining({ stage: "checker-negative:value", passed: false })]),
			);
		},
		120_000,
	);

	it.skipIf(!dockerAvailable)(
		"generates and packages a file larger than the old 1 MiB JSON output limit",
		async () => {
			const project = await createProject();
			await json(`/projects/${project.id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: "Large",
					slug: "large-file",
					statement: "# Large\n\n输出输入字节数。",
					timeLimit: "5s",
					reference: { language: "python3", code: "import sys\nprint(len(sys.stdin.buffer.read()))" },
					generatorSource:
						"#include \"testlib.h\"\n#include <cstdio>\nint main(int argc,char**argv){registerGen(argc,argv,1);for(int i=0;i<1100000;i++)putchar('x');}",
					generatorScript: "gen large 1100000 100",
				}),
			});
			const generated = await json<{
				report: { success: boolean };
				project: { cases: Array<{ inputBytes: number }> };
			}>(`/projects/${project.id}/generate`, { method: "POST" });
			expect(generated.status, JSON.stringify(generated.body)).toBe(200);
			expect(generated.body.report.success).toBe(true);
			expect(generated.body.project.cases[0].inputBytes).toBeGreaterThan(1024 * 1024);
			const finished = await json<{ report: { success: boolean }; release?: { id: string } }>(
				`/projects/${project.id}/finalize`,
				{ method: "POST" },
			);
			expect(finished.body.report.success).toBe(true);
			expect(finished.body.release?.id).toBeTruthy();
		},
		120_000,
	);
});
