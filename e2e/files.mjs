import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Check real ZIP local entries and data; support both stored and deflated exports. */
export function inspectZip(bytes) {
	const files = new Map();
	let offset = 0;
	while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
		const flags = bytes.readUInt16LE(offset + 6), method = bytes.readUInt16LE(offset + 8);
		if (flags & 8) throw new Error("Fixture archive must include local sizes");
		const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
		const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
		const dataStart = offset + 30 + nameLength + extraLength;
		const data = bytes.subarray(dataStart, dataStart + size);
		if (data.length !== size || files.has(name) || name.includes("..")) throw new Error("Invalid archive entry");
		files.set(name, method === 0 ? data : method === 8 ? inflateRawSync(data) : (() => { throw new Error("Unsupported ZIP compression"); })());
		offset = dataStart + size;
	}
	if (!files.size || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory");
	return files;
}

export async function inspectPdf(path, expectedText, testInfo) {
	const loading = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: false });
	const document = await loading.promise;
	try {
		if (document.numPages < 1) throw new Error("Empty PDF");
		let text = "";
		for (let page = 1; page <= document.numPages; page++) {
			const content = await (await document.getPage(page)).getTextContent();
			text += content.items.map(item => "str" in item ? item.str : "").join(" ");
		}
		for (const expected of expectedText) if (!text.replace(/\s+/gu, "").includes(expected.replace(/\s+/gu, ""))) throw new Error(`PDF missing expected text: ${expected}`);
		await testInfo.attach("pdf-text.txt", { body: Buffer.from(text), contentType: "text/plain" });
		const page = await document.getPage(Math.min(2, document.numPages));
		const viewport = page.getViewport({ scale: 1.5 });
		const surface = document.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
		try {
			await page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
			const png = surface.canvas.toBuffer("image/png");
			if (png.length < 5000) throw new Error("PDF page failed to render");
			const rendered = testInfo.outputPath("pdf-rendered-page.png");
			await writeFile(rendered, png);
			await testInfo.attach("pdf-rendered-page", { path: rendered, contentType: "image/png" });
		} finally { document.canvasFactory.destroy(surface); }
	} finally { await loading.destroy(); }
}
