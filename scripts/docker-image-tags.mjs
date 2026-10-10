import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveImageTags(version, ref) {
	if (typeof version !== "string" || version.length > 122 || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(version))
		throw new Error("The project version must be a Docker-compatible version number.");
	const tags = [version];
	if (ref !== "refs/heads/main") {
		const release = /^refs\/tags\/(v|Rev)(\d+\.\d+(?:\.\d+)?)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.exec(ref);
		if (!release || release[0] !== ref) throw new Error("Docker images can only be published from main or a version tag.");
		const numericVersion = release[2].split(".").length === 2 ? `${release[2]}.0` : release[2];
		if (`${numericVersion}${release[3] || ""}` !== version)
			throw new Error("The release tag does not match the project version.");
		if (release[1] === "Rev") tags.push(ref.slice("refs/tags/".length));
	}
	if (!version.includes("-")) tags.push("latest");
	return { version, tags };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const metadata = resolveImageTags(version, process.env.GITHUB_REF);
	if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required to publish image metadata.");
	await appendFile(process.env.GITHUB_OUTPUT, `version=${metadata.version}\ntags=${metadata.tags.join(" ")}\n`);
}
