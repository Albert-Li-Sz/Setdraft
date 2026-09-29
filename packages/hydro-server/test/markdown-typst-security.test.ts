import { afterAll, describe, expect, it } from "vitest";
import { createContestPdfCompiler, renderContestPdf } from "../src/contest-pdf-compiler.ts";
import { typstString } from "../src/markdown-typst.ts";

const compiler = await createContestPdfCompiler();

afterAll(() => compiler.reset());

async function compileMath(source: string, mode: "math" | "text" = "math") {
	try {
		const document = await renderContestPdf(
			compiler,
			`#import "/mitex/lib.typ": mitex\n#set text(font: "New Computer Modern Math")\n#mitex(${typstString(source)}, mode: ${typstString(mode)})`,
		);
		return { document, diagnostics: "" };
	} catch (error) {
		return { document: undefined, diagnostics: error instanceof Error ? error.message : String(error) };
	}
}

describe("untrusted LaTeX dimension handling", () => {
	it.each([
		String.raw`\hspace{\text{panic("SETDRAFT_EVAL_PROBE")}}`,
		String.raw`\vspace{\text{panic("SETDRAFT_EVAL_PROBE")}}`,
		String.raw`\raisebox{\text{panic("SETDRAFT_EVAL_PROBE")}}{x}`,
		String.raw`\hspace{\text{read("/lib.typ")}}`,
		String.raw`\vspace{\text{1pt+2pt}}`,
	])("rejects %s without evaluating its argument", async (source) => {
		const result = await compileMath(source);
		expect(result.document).toBeFalsy();
		expect(result.diagnostics).toContain("Expected a numeric LaTeX length");
		expect(result.diagnostics).not.toContain('panicked with: "SETDRAFT_EVAL_PROBE"');
	});

	it.each(["1pt", "1bp", "2pc", "0.5mm", "1cm", "1in", "1em", "1ex", "2mu", "1sp", "-0.5em", ".5em"])(
		"renders a supported dimension %s",
		async (dimension) => {
			const source = String.raw`x\hspace{${dimension}}y+\raisebox{${dimension}}{z}`;
			const result = await compileMath(source);
			expect(result.diagnostics).toBe("");
			expect(result.document).toBeTruthy();
		},
	);

	it("preserves standard formula conversion and rejects excessive dimensions", async () => {
		const normal = await compileMath(String.raw`\frac{1}{2}+\sqrt{x^2+y^2}+\sum_{i=1}^{n}i+\vspace{1pt}`);
		expect(normal.diagnostics).toBe("");
		expect(normal.document).toBeTruthy();
		const excessive = await compileMath(String.raw`\hspace{10001pt}`);
		expect(excessive.document).toBeFalsy();
		expect(excessive.diagnostics).toContain("LaTeX length magnitude exceeds 10000");
	});

	it.each(["math", "text"] as const)("rejects images and image-path code injection in %s mode", async (mode) => {
		for (const source of [
			String.raw`\includegraphics{/lib.typ}`,
			String.raw`\includegraphics{https://example.com/image.png}`,
			String.raw`\includegraphics{")#panic("SETDRAFT_IMAGE_PROBE")#image("}`,
			String.raw`\includegraphics{"+panic("SETDRAFT_IMAGE_PROBE")+"}`,
		]) {
			const result = await compileMath(source, mode);
			expect(result.document).toBeFalsy();
			expect(result.diagnostics).toContain("公式中不支持图片，请使用 Markdown 附件");
			expect(result.diagnostics).not.toContain('panicked with: "SETDRAFT_IMAGE_PROBE"');
		}
	});

	it("keeps apparent Typst commands inside formula text inert", async () => {
		const result = await compileMath(
			String.raw`\text{#read("/lib.typ") #plugin("/mitex.wasm") #query(heading) #panic("SETDRAFT_TEXT_PROBE")}`,
		);
		expect(result.document).toBeTruthy();
		expect(result.diagnostics).toBe("");
	});
});
