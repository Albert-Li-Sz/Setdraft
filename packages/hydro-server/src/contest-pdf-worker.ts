import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TypstCompiler } from "@myriaddreamin/typst.ts/compiler";
import { SaxesParser } from "saxes";
import { createContestPdfCompiler, renderContestPdf } from "./contest-pdf-compiler.ts";
import { buildContestPdfSources, type ContestPdfDocument } from "./contest-pdf-document.ts";

const directory = process.argv[2];
let compiler: TypstCompiler | undefined;

function validateSvg(bytes: Buffer): void {
	if (bytes.length > 256 * 1024) throw new Error("PDF SVG 不能超过 256 KiB。");
	const allowedElements = new Set([
		"svg",
		"g",
		"defs",
		"title",
		"desc",
		"path",
		"rect",
		"circle",
		"ellipse",
		"line",
		"polyline",
		"polygon",
		"text",
		"tspan",
		"linearGradient",
		"radialGradient",
		"stop",
	]);
	const allowedAttributes = new Set([
		"id",
		"role",
		"aria-label",
		"aria-labelledby",
		"aria-describedby",
		"version",
		"x",
		"y",
		"x1",
		"y1",
		"x2",
		"y2",
		"dx",
		"dy",
		"cx",
		"cy",
		"r",
		"rx",
		"ry",
		"fx",
		"fy",
		"width",
		"height",
		"viewBox",
		"preserveAspectRatio",
		"d",
		"points",
		"transform",
		"fill",
		"fill-opacity",
		"fill-rule",
		"stroke",
		"stroke-width",
		"stroke-opacity",
		"stroke-linecap",
		"stroke-linejoin",
		"stroke-miterlimit",
		"stroke-dasharray",
		"stroke-dashoffset",
		"opacity",
		"font-family",
		"font-size",
		"font-weight",
		"font-style",
		"text-anchor",
		"dominant-baseline",
		"textLength",
		"lengthAdjust",
		"gradientUnits",
		"gradientTransform",
		"spreadMethod",
		"offset",
		"stop-color",
		"stop-opacity",
	]);
	const parser = new SaxesParser({ xmlns: true });
	let nodes = 0;
	let depth = 0;
	parser.on("doctype", () => {
		throw new Error("PDF SVG 不允许 DTD 或实体声明。");
	});
	parser.on("processinginstruction", () => {
		throw new Error("PDF SVG 不允许处理指令。");
	});
	parser.on("opentag", (tag) => {
		nodes++;
		depth++;
		if (nodes > 5000 || depth > 32) throw new Error("PDF SVG 最多 5000 个节点、32 层嵌套。");
		if (
			(nodes === 1 && tag.local !== "svg") ||
			!allowedElements.has(tag.local) ||
			(tag.uri !== "" && tag.uri !== "http://www.w3.org/2000/svg")
		)
			throw new Error("PDF SVG 仅支持基本矢量形状、文本和渐变，不允许嵌图、脚本、样式、外链、use 或滤镜。");
		const attributes = Object.values(tag.attributes);
		if (attributes.length > 40) throw new Error("PDF SVG 单个节点属性过多。");
		for (const attribute of attributes) {
			if (attribute.uri === "http://www.w3.org/2000/xmlns/" && attribute.value === "http://www.w3.org/2000/svg")
				continue;
			if (
				attribute.uri === "http://www.w3.org/XML/1998/namespace" &&
				attribute.local === "space" &&
				["default", "preserve"].includes(attribute.value)
			)
				continue;
			if (attribute.uri !== "" || !allowedAttributes.has(attribute.local) || attribute.value.length > 65_536)
				throw new Error("PDF SVG 包含不支持的属性或外部资源引用。");
			if (
				/url\s*\(/iu.test(attribute.value) &&
				!/^url\(\s*#[A-Za-z_][A-Za-z0-9_.-]{0,100}\s*\)$/u.test(attribute.value)
			)
				throw new Error("PDF SVG 只允许引用本图内的渐变。");
		}
	});
	parser.on("closetag", () => {
		depth--;
	});
	parser.on("error", () => {
		throw new Error("PDF SVG 的 XML 格式无效。");
	});
	parser.write(bytes.toString("utf8")).close();
	if (nodes === 0) throw new Error("PDF SVG 不能为空。");
}

function rasterDimensions(bytes: Buffer, extension: string): { width: number; height: number } | undefined {
	if (
		extension === "png" &&
		bytes.length >= 24 &&
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	if (extension === "gif" && bytes.length >= 10 && /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii")))
		return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	if ((extension === "jpg" || extension === "jpeg") && bytes.length >= 2 && bytes.readUInt16BE(0) === 0xffd8) {
		let offset = 2;
		while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
			while (bytes[offset] === 0xff) offset++;
			const marker = bytes[offset++];
			if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			const length = bytes.readUInt16BE(offset);
			if (length < 2 || offset + length > bytes.length) break;
			if (
				[0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
				length >= 7
			)
				return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
			offset += length;
		}
	}
	return undefined;
}

try {
	const jobPath = join(directory, "job.json");
	if ((await stat(jobPath)).size > 20 * 1024 * 1024) throw new Error("PDF 输入不能超过 20 MiB。");
	const job = JSON.parse(await readFile(jobPath, "utf8")) as { document: ContestPdfDocument; bookletOnly: boolean };
	const labels = job.document.problems.map((problem) => problem.label);
	if (
		labels.length < 1 ||
		labels.length > 100 ||
		new Set(labels).size !== labels.length ||
		labels.some((label) => !/^[A-Z]{1,3}$/u.test(label))
	)
		throw new Error("PDF 题号无效。");
	for (const problem of job.document.problems) {
		if (problem.attachments.length > 20) throw new Error("每题 PDF 附件不能超过 20 个。");
		for (const attachment of problem.attachments)
			if (Buffer.byteLength(attachment.contentBase64, "base64") > 1024 * 1024)
				throw new Error("单个 PDF 附件不能超过 1 MiB。");
	}
	const source = buildContestPdfSources(job.document);
	const documents = new Map([["booklet", source.booklet], ...(job.bookletOnly ? [] : [...source.problems])]);
	if ([...documents.values()].reduce((total, text) => total + Buffer.byteLength(text), 0) > 40 * 1024 * 1024)
		throw new Error("PDF 排版源文件合计不能超过 40 MiB。");
	let imageBytes = 0;
	let imagePixels = 0;
	for (const [name, bytes] of source.assets) {
		if (!/^images\/[A-Z]{1,3}-\d+\.(png|jpe?g|gif|svg)$/u.test(name)) throw new Error("PDF 图片路径无效。");
		imageBytes += bytes.length;
		if (imageBytes > 16 * 1024 * 1024) throw new Error("PDF 图片合计不能超过 16 MiB。");
		const extension = name.split(".").at(-1) ?? "";
		if (extension === "svg") validateSvg(bytes);
		else {
			const dimensions = rasterDimensions(bytes, extension);
			if (
				!dimensions ||
				dimensions.width < 1 ||
				dimensions.height < 1 ||
				dimensions.width > 8192 ||
				dimensions.height > 8192 ||
				dimensions.width * dimensions.height > 16_000_000
			)
				throw new Error("PDF 图片无效，或尺寸超过 8192 边长 / 1600 万像素。");
			imagePixels += dimensions.width * dimensions.height;
			if (imagePixels > 64_000_000) throw new Error("PDF 图片合计不能超过 6400 万像素。");
		}
	}
	compiler = await createContestPdfCompiler();
	for (const [name, bytes] of source.assets) compiler.mapShadow(`/${name}`, bytes);
	compiler.mapShadow(
		"/allowed-images.json",
		Buffer.from(JSON.stringify([...source.assets.keys()].map((name) => `/${name}`))),
	);
	let totalBytes = 0;
	for (const [name, content] of documents) {
		const { pdf } = await renderContestPdf(compiler, content);
		totalBytes += pdf.length;
		if (totalBytes > 64 * 1024 * 1024) throw new Error("PDF 文件合计超过 64 MiB。");
		await writeFile(join(directory, `${name}.pdf`), pdf);
		if ((await stat(join(directory, `${name}.pdf`))).size < 100) throw new Error("PDF 生成结果为空。");
	}
} catch (error) {
	process.stderr.write(error instanceof Error ? error.message : "PDF 生成失败。");
	process.exitCode = 1;
} finally {
	await compiler?.reset();
}
