import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

let available = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	available = true;
} catch {}
it.skipIf(!available)(
	"compares large finite values separately from IEEE infinity in native C++11 and C++26",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-testlib-numbers-"));
		try {
			await copyFile(new URL("../sandbox/testlib/testlib.h", import.meta.url), join(root, "testlib.h"));
			await writeFile(
				join(root, "main.cc"),
				`#include "testlib.h"
int main(int argc,char**argv){registerGen(argc,argv,1);
double inf=std::numeric_limits<double>::infinity(), nan=std::numeric_limits<double>::quiet_NaN();
if(doubleCompare(1e301,1e302,1e-6)||doubleCompare(1e301,inf,1e-6)||doubleCompare(inf,1e301,1e-6)||doubleCompare(inf,-inf,1e-6))return 1;
if(!doubleCompare(1e308,1e308*(1+1e-7),1e-6)||!doubleCompare(-1e308,-1e308*(1+1e-7),1e-6)||!doubleCompare(inf,inf,1e-6)||!doubleCompare(nan,nan,1e-6)||!doubleCompare(0,-0.0,1e-6))return 2;
if(doubleCompare(1e308,1e307,1e-6)||doubleCompare(1.0,nan,1e-6))return 3;
return 0;}`,
			);
			const output = execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--mount",
					`type=bind,source=${root},target=/probe,readonly`,
					"--entrypoint",
					"sh",
					"setdraft/sandbox:local",
					"-c",
					"g++ -std=c++11 -I/probe /probe/main.cc -o /tmp/probe11 && /tmp/probe11 && g++ -std=c++26 -I/probe /probe/main.cc -o /tmp/probe26 && /tmp/probe26 && echo passed",
				],
				{ encoding: "utf8", timeout: 60_000 },
			);
			expect(output.trim()).toBe("passed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);
