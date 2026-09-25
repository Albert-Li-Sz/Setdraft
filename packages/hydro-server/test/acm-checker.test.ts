import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { defaultTextChecker } from "../src/acm-checker.ts";

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["image", "inspect", "hydro-problem-make/sandbox:local"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

it.skipIf(!dockerAvailable)(
	"accepts equal text and rejects different text",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hydro-checker-"));
		try {
			await writeFile(join(directory, "checker.cc"), defaultTextChecker);
			await copyFile(
				fileURLToPath(new URL("../sandbox/testlib/testlib.h", import.meta.url)),
				join(directory, "testlib.h"),
			);
			await writeFile(join(directory, "input.in"), "1 2\n");
			await writeFile(join(directory, "answer.out"), "3\n");
			await writeFile(join(directory, "equivalent.out"), "3 \r\n\r\n");
			await writeFile(join(directory, "wrong.out"), "4\n");
			const run = (output: string) => {
				try {
					const stdout = execFileSync(
						"docker",
						[
							"run",
							"--rm",
							"--network",
							"none",
							"--mount",
							`type=bind,source=${directory},target=/work`,
							"--workdir",
							"/work",
							"hydro-problem-make/sandbox:local",
							"sh",
							"-c",
							`g++ -std=c++17 -I. checker.cc -o checker && ./checker input.in ${output} answer.out`,
						],
						{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
					);
					return { passed: true, output: stdout };
				} catch (error) {
					return { passed: false, output: error instanceof Error ? error.message : String(error) };
				}
			};
			expect(run("answer.out").passed).toBe(true);
			expect(run("equivalent.out").passed).toBe(true);
			expect(run("wrong.out")).toMatchObject({ passed: false, output: expect.stringContaining("wrong answer") });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	60_000,
);
