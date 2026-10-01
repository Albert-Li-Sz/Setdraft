import {
	markdownAttachmentName,
	markdownReferences,
	parseMarkdown,
	safeMarkdownUrl,
	serializeMarkdown,
	walkMarkdown,
} from "@setdraft/authoring/markdown";

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

/** Resolve first-wins footnotes in one logical statement; definitions never render twice. */
export function preparePdfFootnotes(parts: string[]): { parts: string[]; footnotes: string[] } {
	let document = "";
	const ranges = parts.map((part, index) => {
		document += `## section-${index}\n\n`;
		const start = document.length;
		document += `${part}\n\n`;
		return { start, end: start + part.length };
	});
	const tree = parseMarkdown(document);
	const definitions = new Map<string, string>();
	const edits: Array<{ start: number; end: number; text: string }> = [];
	walkMarkdown(tree, (node) => {
		if (node.type !== "footnoteDefinition" || !node.position) return;
		if (!definitions.has(node.identifier))
			definitions.set(node.identifier, serializeMarkdown({ type: "root", children: node.children }));
		edits.push({ start: node.position.start.offset!, end: node.position.end.offset!, text: "" });
	});
	const footnotes: string[] = [];
	const numbers = new Map<string, number>();
	const definitionRanges = [...edits];
	walkMarkdown(tree, (node) => {
		if (node.type !== "footnoteReference" || !node.position) return;
		const start = node.position.start.offset!,
			end = node.position.end.offset!;
		if (definitionRanges.some((edit) => start >= edit.start && end <= edit.end)) return;
		const definition = definitions.get(node.identifier);
		if (definition === undefined) return;
		const first = !numbers.has(node.identifier);
		if (first) {
			numbers.set(node.identifier, footnotes.length);
			footnotes.push(definition);
		}
		edits.push({
			start,
			end,
			text: `<setdraft-footnote data-note="${numbers.get(node.identifier)}" data-first="${first ? "1" : "0"}"></setdraft-footnote>`,
		});
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
