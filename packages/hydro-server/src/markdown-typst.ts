import {
	markdownAttachmentName,
	markdownReferences,
	parseMarkdown,
	safeMarkdownUrl,
	serializeMarkdown,
	walkMarkdown,
} from "@setdraft/authoring/markdown";
import type { FootnoteDefinition, RootContent } from "mdast";

export function typstString(value: string): string {
	return `"${value.replace(/["\\\u0000-\u001f\u007f-\u009f]/gu, (character) => {
		if (character === '"' || character === "\\") return `\\${character}`;
		return `\\u{${character.codePointAt(0)!.toString(16)}}`;
	})}"`;
}

export function preparePdfMarkdown(markdown: string, images: ReadonlyMap<string, string> = new Map()): string {
	return preparePdfMarkdownParts([markdown], images)[0];
}

/** Parse the complete logical statement before rewriting each section for its independent renderer. */
export function preparePdfMarkdownParts(parts: string[], images: ReadonlyMap<string, string> = new Map()): string[] {
	let prepared = parts;
	for (const pass of ["images", "links"] as const) {
		const ranges: Array<{ start: number; end: number }> = [];
		let document = "";
		for (const [index, part] of prepared.entries()) {
			document += `## section-${index}\n\n`;
			ranges.push({ start: document.length, end: document.length + part.length });
			document += `${part}\n\n`;
		}
		const edits: Array<{ start: number; end: number; text: string }> = [];
		for (const { node, url, title } of markdownReferences(document)) {
			const image = node.type === "image" || node.type === "imageReference";
			if (pass === "images" ? !image : image) continue;
			const start = node.position?.start.offset,
				end = node.position?.end.offset;
			if (start === undefined || end === undefined) throw new Error("PDF 引用位置无效。");
			let text: string;
			if (image) {
				const name = markdownAttachmentName(url);
				const path = images.get(name ? `file://${name}` : url);
				if (!path) throw new Error(`PDF 图片必须引用已上传的 PNG、JPEG、GIF 或 SVG 附件：${url.slice(0, 120)}`);
				const alt = (node.alt ?? "").replace(/[\\[\]]/gu, "\\$&").replace(/[\r\n]/gu, " ");
				text = `![${alt}](${path})`;
			} else {
				const attachment = markdownAttachmentName(url);
				if (safeMarkdownUrl(url) === undefined && !attachment)
					throw new Error("PDF 链接使用了不支持的协议或附件路径。");
				if (node.type === "link" && !attachment) continue;
				if (!("children" in node)) continue;
				const labelStart = node.children[0]?.position?.start.offset;
				const labelEnd = node.children.at(-1)?.position?.end.offset;
				const label =
					labelStart === undefined || labelEnd === undefined ? "" : document.slice(labelStart, labelEnd);
				const destination = (attachment ? `file://${attachment}` : url)
					.replaceAll("&", "&amp;")
					.replace(/[<>\r\n]/gu, encodeURIComponent);
				const suffix = title ? ` "${title.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"` : "";
				text = `[${label}](<${destination}>${suffix})`;
			}
			edits.push({ start, end, text });
		}
		prepared = prepared.map((part, index) => {
			const range = ranges[index];
			for (const edit of edits
				.filter((edit) => edit.start >= range.start && edit.start < range.end)
				.sort((a, b) => b.start - a.start)) {
				if (edit.end > range.end) throw new Error("PDF 引用不能跨越题面章节边界。");
				part = part.slice(0, edit.start - range.start) + edit.text + part.slice(edit.end - range.start);
			}
			return part;
		});
	}
	return prepared;
}

interface PdfFootnote {
	body: string;
	/** Newly reached descendants, in the order their entries must be emitted. */
	nested: number[];
}

/** Resolve the reachable first-wins reference graph; cycles never silently lose content. */
export function preparePdfFootnotes(parts: string[]): { parts: string[]; footnotes: PdfFootnote[] } {
	let document = "";
	const ranges = parts.map((part, index) => {
		document += `## section-${index}\n\n`;
		const start = document.length;
		document += `${part}\n\n`;
		return { start, end: start + part.length };
	});
	const tree = parseMarkdown(document);
	const definitions = new Map<string, FootnoteDefinition>();
	const edits: Array<{ start: number; end: number; text: string }> = [];
	walkMarkdown(tree, (node) => {
		if (node.type !== "footnoteDefinition" || !node.position) return;
		if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
		edits.push({ start: node.position.start.offset!, end: node.position.end.offset!, text: "" });
	});
	const footnotes: PdfFootnote[] = [];
	const numbers = new Map<string, number>();
	const definitionRanges = [...edits];
	const marker = (index: number, first: boolean) =>
		`<setdraft-footnote data-note="${index}" data-first="${first ? "1" : "0"}"></setdraft-footnote>`;
	const privateHtml = (node: RootContent) =>
		node.type === "html" && /<\/?setdraft-footnote(?=[ \t\r\n\f\v/>])/iu.test(node.value);
	function register(identifier: string, path: string[]): { index: number; first: boolean } {
		if (path.includes(identifier)) throw new Error(`PDF 脚注存在循环引用：${[...path, identifier].join(" → ")}。`);
		if (path.length >= 80) throw new Error("PDF 脚注嵌套过深，请简化引用。");
		const existing = numbers.get(identifier);
		if (existing !== undefined) return { index: existing, first: false };
		const definition = definitions.get(identifier);
		if (!definition) throw new Error(`PDF 脚注定义不存在：${identifier}。`);
		const index = footnotes.length;
		const note: PdfFootnote = { body: "", nested: [] };
		numbers.set(identifier, index);
		footnotes.push(note);
		function render(node: RootContent): RootContent {
			if (node.type === "footnoteReference") {
				const nested = register(node.identifier, [...path, identifier]);
				if (nested.first) note.nested.push(nested.index, ...footnotes[nested.index].nested);
				return { type: "html", value: marker(nested.index, false) };
			}
			if (node.type === "html" && privateHtml(node)) return { type: "text", value: node.value };
			// A footnote reference and its HTML replacement are both phrasing nodes.
			if ("children" in node) return { ...node, children: node.children.map(render) } as RootContent;
			return node;
		}
		note.body = serializeMarkdown({ type: "root", children: definition.children.map(render) });
		return { index, first: true };
	}
	walkMarkdown(tree, (node) => {
		if (!node.position) return;
		const start = node.position.start.offset!,
			end = node.position.end.offset!;
		if (definitionRanges.some((edit) => start >= edit.start && end <= edit.end)) return;
		if (node.type === "html" && privateHtml(node)) {
			edits.push({
				start,
				end,
				text: node.value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
			});
			return;
		}
		if (node.type !== "footnoteReference") return;
		const { index, first } = register(node.identifier, []);
		edits.push({ start, end, text: marker(index, first) });
	});
	return {
		footnotes,
		parts: parts.map((part, index) => {
			const range = ranges[index];
			for (const edit of edits
				.filter((edit) => edit.start >= range.start && edit.end <= range.end)
				.sort((a, b) => b.start - a.start))
				part = part.slice(0, edit.start - range.start) + edit.text + part.slice(edit.end - range.start);
			return part.trim();
		}),
	};
}
