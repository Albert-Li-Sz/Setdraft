import { readFile } from "node:fs/promises";
import { createTypstCompiler, type TypstCompiler } from "@myriaddreamin/typst.ts/compiler";
import { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";
import {
	disableDefaultFontAssets,
	loadFonts,
	withAccessModel,
	withPackageRegistry,
} from "@myriaddreamin/typst.ts/options.init";
import * as wasmCompiler from "@myriaddreamin/typst-ts-web-compiler";

export async function createContestPdfCompiler(): Promise<TypstCompiler> {
	const fontNames = [
		"NewCMMath-Book.otf",
		"cmunss.otf",
		"cmunsx.otf",
		"cmuntt.ttf",
		"FZSSK.ttf",
		"FZHTK.ttf",
		"FZKTK.ttf",
		"FZXBSK.ttf",
	];
	const fonts = await Promise.all(
		fontNames.map((name) => readFile(new URL(`../assets/xcpc/fonts/${name}`, import.meta.url))),
	);
	const wasm = await readFile(new URL(import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/wasm")));
	await wasmCompiler.default({ module_or_path: wasm });
	const compiler = createTypstCompiler();
	await compiler.init({
		getWrapper: async () => wasmCompiler,
		beforeBuild: [
			disableDefaultFontAssets(),
			loadFonts(fonts),
			withAccessModel(new MemoryAccessModel()),
			withPackageRegistry({ resolve: () => undefined }),
		],
	});
	for (const name of [
		"xcpc/lib.typ",
		"cmarker/lib.typ",
		"cmarker/plugin.wasm",
		"numbly/lib.typ",
		"mitex/lib.typ",
		"mitex/mitex.typ",
		"mitex/mitex.wasm",
		"mitex/specs/mod.typ",
		"mitex/specs/prelude.typ",
		"mitex/specs/latex/standard.typ",
	])
		compiler.mapShadow(`/${name}`, await readFile(new URL(`../assets/${name}`, import.meta.url)));
	compiler.mapShadow("/allowed-images.json", Buffer.from("[]"));
	return compiler;
}

export async function renderContestPdf(compiler: TypstCompiler, source: string) {
	compiler.addSource("/main.typ", `${source}\n#context [#metadata(here().page()) <setdraft-page-count>]`);
	const result = await compiler.runWithWorld({ mainFilePath: "/main.typ" }, async (world) => {
		const compilation = await world.compile({ diagnostics: "full" });
		if (compilation.hasError) return { pages: 0, diagnostics: compilation.diagnostics };
		const pageCounts = await world.query<number[]>({ selector: "<setdraft-page-count>", field: "value" });
		const pages = pageCounts[0] ?? 0;
		if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) return { pages };
		return { pages, ...(await world.pdf({ diagnostics: "full" })) };
	});
	if (result.pages > 1000) throw new Error("PDF 超过 1000 页，请缩减题面内容。");
	if (!("result" in result) || !result.result) {
		const diagnostics = "diagnostics" in result ? result.diagnostics : undefined;
		throw new Error(
			`PDF 排版失败：${JSON.stringify(diagnostics?.filter((entry) => entry.severity === "error") ?? []).slice(0, 4000)}`,
		);
	}
	return { pages: result.pages, pdf: result.result };
}
