import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { HydroDirectoryArchiveError } from "./archive.ts";
import { validateHydroDirectory } from "./directory-validator.ts";
import type { DirectoryValidationOptions } from "./types.ts";
import { isSafeFlatName } from "./validation.ts";

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	crcTable[index] = value >>> 0;
}

interface ZipEntry {
	name: Buffer;
	size: number;
	crc: number;
	offset: number;
	path: string;
}

function encodedName(rootName: string, relativePath: string): Buffer {
	if (!isSafeFlatName(rootName) || !relativePath.split("/").every(isSafeFlatName)) {
		throw new Error(`Unsafe archive path: ${relativePath}`);
	}
	const name = Buffer.from(`${rootName}/${relativePath}`);
	if (name.byteLength > 0xffff) throw new Error("Archive path exceeds ZIP32 limit.");
	return name;
}

async function fileCrc(path: string): Promise<{ size: number; crc: number }> {
	const stats = await lstat(path);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Archive source is not a regular file: ${path}`);
	if (stats.size > 0xffffffff) throw new Error("Archive file exceeds ZIP32 limit.");
	let crc = 0xffffffff;
	for await (const chunk of createReadStream(path)) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return { size: stats.size, crc: (crc ^ 0xffffffff) >>> 0 };
}

/** Write deterministic uncompressed ZIP32 content without buffering the entire dataset. */
export async function writeStoredArchiveFromFiles(
	destination: string,
	rootName: string,
	files: ReadonlyMap<string, string>,
): Promise<void> {
	if (files.size > 0xffff) throw new Error("Archive has too many entries for ZIP32.");
	const handle = await open(destination, "wx");
	const entries: ZipEntry[] = [];
	let offset = 0;
	try {
		const write = async (data: Buffer): Promise<void> => {
			let written = 0;
			while (written < data.byteLength) {
				const result = await handle.write(data, written, data.byteLength - written, offset + written);
				if (result.bytesWritten <= 0) throw new Error("Archive write stopped unexpectedly.");
				written += result.bytesWritten;
			}
			offset += data.byteLength;
			if (offset > 0xffffffff) throw new Error("Archive exceeds ZIP32 limit.");
		};
		for (const [relativePath, path] of [...files].sort(([left], [right]) => left.localeCompare(right, "en"))) {
			const name = encodedName(rootName, relativePath);
			const { size, crc } = await fileCrc(path);
			const entry: ZipEntry = { name, size, crc, offset, path };
			const header = Buffer.alloc(30);
			header.writeUInt32LE(0x04034b50, 0);
			header.writeUInt16LE(20, 4);
			header.writeUInt16LE(0x0800, 6);
			header.writeUInt16LE(0, 8);
			header.writeUInt16LE(0, 10);
			header.writeUInt16LE(0x21, 12);
			header.writeUInt32LE(crc, 14);
			header.writeUInt32LE(size, 18);
			header.writeUInt32LE(size, 22);
			header.writeUInt16LE(name.byteLength, 26);
			await write(header);
			await write(name);
			let streamed = 0;
			for await (const chunk of createReadStream(path)) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				streamed += bytes.byteLength;
				await write(bytes);
			}
			if (streamed !== size) throw new Error(`Archive source changed while writing: ${relativePath}`);
			entries.push(entry);
		}
		const centralOffset = offset;
		for (const entry of entries) {
			const header = Buffer.alloc(46);
			header.writeUInt32LE(0x02014b50, 0);
			header.writeUInt16LE(0x0314, 4);
			header.writeUInt16LE(20, 6);
			header.writeUInt16LE(0x0800, 8);
			header.writeUInt16LE(0, 10);
			header.writeUInt16LE(0, 12);
			header.writeUInt16LE(0x21, 14);
			header.writeUInt32LE(entry.crc, 16);
			header.writeUInt32LE(entry.size, 20);
			header.writeUInt32LE(entry.size, 24);
			header.writeUInt16LE(entry.name.byteLength, 28);
			header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
			header.writeUInt32LE(entry.offset, 42);
			await write(header);
			await write(entry.name);
		}
		const centralSize = offset - centralOffset;
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(centralSize, 12);
		end.writeUInt32LE(centralOffset, 16);
		await write(end);
	} finally {
		await handle.close();
	}
}

export async function writeHydroDirectoryArchive(
	problemDirectory: string,
	destination: string,
	options: DirectoryValidationOptions = {},
): Promise<void> {
	const root = resolve(problemDirectory);
	const report = await validateHydroDirectory(root, options);
	if (!report.valid) throw new HydroDirectoryArchiveError(report);
	const files = new Map<string, string>();
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isFile()) files.set(entry.name, join(root, entry.name));
		else if (entry.isDirectory() && (entry.name === "testdata" || entry.name === "additional_file")) {
			for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
				if (!child.isFile()) throw new Error(`Unsafe archive entry: ${entry.name}/${child.name}`);
				files.set(`${entry.name}/${child.name}`, join(root, entry.name, child.name));
			}
		}
	}
	await writeStoredArchiveFromFiles(destination, basename(root), files);
}
