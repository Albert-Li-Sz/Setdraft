import { execFileSync } from "node:child_process";
import { it } from "vitest";

let available = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	available = true;
} catch (cause) {
	if (process.env.SETDRAFT_REQUIRE_SANDBOX === "1")
		throw new Error("Release verification requires the setdraft/sandbox:local image.", { cause });
}

export const sandboxIt: ReturnType<typeof it.skipIf> = it.skipIf(!available);
