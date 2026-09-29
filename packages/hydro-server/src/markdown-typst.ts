import type { Definition, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function typstString(value: string): string {
	return `"${value.replace(/["\\\u0000-\u001f\u007f-\u009f]/gu, (character) => {
		if (character === '"' || character === "\\") return `\\${character}`;
		return `\\u{${character.codePointAt(0)!.toString(16)}}`;
	})}"`;
}

export function preparePdfMarkdown(markdown: string, images: ReadonlyMap<string, string> = new Map()): string {
	const tree = parser.parse(markdown);
	const definitions = new Map<string, Definition>();
	for (const node of tree.children) if (node.type === "definition") definitions.set(node.identifier, node);
	const edits: Array<{ start: number; end: number; text: string }> = [];
	let count = 0;
	const visit = (node: RootContent, depth: number): void => {
		if (++count > 30_000 || depth > 80) throw new Error("PDF Markdown 结构过于复杂，请简化嵌套或拆分内容。");
		if (node.type === "image" || node.type === "imageReference") {
			const url = node.type === "image" ? node.url : (definitions.get(node.identifier)?.url ?? "");
			const path = images.get(url);
			if (!path) throw new Error(`PDF 图片必须引用已上传的 PNG、JPEG、GIF 或 SVG 附件：${url.slice(0, 120)}`);
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start === undefined || end === undefined) throw new Error("PDF 图片位置无效。");
			const alt = (node.alt ?? "").replace(/[\\[\]]/gu, "\\$&").replace(/[\r\n]/gu, " ");
			edits.push({ start, end, text: `![${alt}](${path})` });
		}
		if ("children" in node) for (const child of node.children) visit(child, depth + 1);
	};
	for (const node of tree.children) visit(node, 0);
	let prepared = markdown;
	for (const edit of edits.sort((left, right) => right.start - left.start))
		prepared = prepared.slice(0, edit.start) + edit.text + prepared.slice(edit.end);
	return prepared;
}
