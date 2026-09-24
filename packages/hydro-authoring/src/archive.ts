import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildHydroProblemFiles } from "./builder.ts";
import { validateHydroDirectory } from "./directory-validator.ts";
import type { DirectoryValidationOptions, HydroJudgeLimits, HydroProblemSpec, ValidationReport } from "./types.ts";
import { isSafeFlatName } from "./validation.ts";

const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

interface ZipEntry {
	name: Uint8Array;
	content: Uint8Array;
	crc32: number;
	offset: number;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	crcTable[index] = value >>> 0;
}

function crc32(content: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of content) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function assertUint16(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT16) {
		throw new Error(`${label} exceeds the ZIP32 limit.`);
	}
}

function assertUint32(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
		throw new Error(`${label} exceeds the ZIP32 limit.`);
	}
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function localHeader(entry: ZipEntry): Uint8Array {
	const output = Buffer.alloc(30);
	output.writeUInt32LE(0x04034b50, 0);
	output.writeUInt16LE(20, 4);
	output.writeUInt16LE(UTF8_FLAG, 6);
	output.writeUInt16LE(STORED_METHOD, 8);
	output.writeUInt16LE(DOS_TIME, 10);
	output.writeUInt16LE(DOS_DATE, 12);
	output.writeUInt32LE(entry.crc32, 14);
	output.writeUInt32LE(entry.content.byteLength, 18);
	output.writeUInt32LE(entry.content.byteLength, 22);
	output.writeUInt16LE(entry.name.byteLength, 26);
	output.writeUInt16LE(0, 28);
	return output;
}

function centralHeader(entry: ZipEntry): Uint8Array {
	const output = Buffer.alloc(46);
	output.writeUInt32LE(0x02014b50, 0);
	output.writeUInt16LE(0x0314, 4);
	output.writeUInt16LE(20, 6);
	output.writeUInt16LE(UTF8_FLAG, 8);
	output.writeUInt16LE(STORED_METHOD, 10);
	output.writeUInt16LE(DOS_TIME, 12);
	output.writeUInt16LE(DOS_DATE, 14);
	output.writeUInt32LE(entry.crc32, 16);
	output.writeUInt32LE(entry.content.byteLength, 20);
	output.writeUInt32LE(entry.content.byteLength, 24);
	output.writeUInt16LE(entry.name.byteLength, 28);
	output.writeUInt16LE(0, 30);
	output.writeUInt16LE(0, 32);
	output.writeUInt16LE(0, 34);
	output.writeUInt16LE(0, 36);
	output.writeUInt32LE((0o100644 << 16) >>> 0, 38);
	output.writeUInt32LE(entry.offset, 42);
	return output;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
	const output = Buffer.alloc(22);
	output.writeUInt32LE(0x06054b50, 0);
	output.writeUInt16LE(0, 4);
	output.writeUInt16LE(0, 6);
	output.writeUInt16LE(entryCount, 8);
	output.writeUInt16LE(entryCount, 10);
	output.writeUInt32LE(centralSize, 12);
	output.writeUInt32LE(centralOffset, 16);
	output.writeUInt16LE(0, 20);
	return output;
}

export function buildStoredArchive(rootName: string, files: Iterable<readonly [string, Uint8Array]>): Uint8Array {
	if (!isSafeFlatName(rootName)) throw new Error("Archive root must be a flat ASCII name.");
	const encoder = new TextEncoder();
	const sourceFiles = [...files].sort(([left], [right]) => comparePath(left, right));
	assertUint16(sourceFiles.length, "Archive entry count");

	const entries: ZipEntry[] = [];
	const localParts: Uint8Array[] = [];
	let localOffset = 0;
	const paths = new Set<string>();
	for (const [relativePath, content] of sourceFiles) {
		if (!relativePath.split("/").every(isSafeFlatName) || paths.has(relativePath))
			throw new Error("Archive paths must be unique, safe relative paths.");
		paths.add(relativePath);
		const name = encoder.encode(`${rootName}/${relativePath}`);
		assertUint16(name.byteLength, `Archive path ${relativePath}`);
		assertUint32(content.byteLength, `Archive file ${relativePath}`);
		const entry = { name, content, crc32: crc32(content), offset: localOffset };
		const header = localHeader(entry);
		entries.push(entry);
		localParts.push(header, name, content);
		localOffset += header.byteLength + name.byteLength + content.byteLength;
		assertUint32(localOffset, "Archive content");
	}

	const centralParts: Uint8Array[] = [];
	let centralSize = 0;
	for (const entry of entries) {
		const header = centralHeader(entry);
		centralParts.push(header, entry.name);
		centralSize += header.byteLength + entry.name.byteLength;
	}
	assertUint32(centralSize, "Archive directory");
	const archive = Buffer.concat([
		...localParts.map((part) => Buffer.from(part)),
		...centralParts.map((part) => Buffer.from(part)),
		Buffer.from(endOfCentralDirectory(entries.length, centralSize, localOffset)),
	]);
	assertUint32(archive.byteLength, "Archive");
	return archive;
}

export class HydroDirectoryArchiveError extends Error {
	readonly report: ValidationReport;

	constructor(report: ValidationReport) {
		super("The Hydro problem directory did not pass validation.");
		this.name = "HydroDirectoryArchiveError";
		this.report = report;
	}
}

/** Build a byte-for-byte reproducible ZIP accepted by Hydro's problem importer. */
export function buildHydroProblemArchive(spec: HydroProblemSpec, judgeLimits?: HydroJudgeLimits): Uint8Array {
	return buildStoredArchive(spec.slug, buildHydroProblemFiles(spec, judgeLimits));
}

/** Revalidate and archive a generated Hydro release directory. */
export async function buildHydroDirectoryArchive(
	problemDirectory: string,
	options: DirectoryValidationOptions = {},
): Promise<Uint8Array> {
	const root = resolve(problemDirectory);
	const report = await validateHydroDirectory(root, options);
	if (!report.valid) throw new HydroDirectoryArchiveError(report);
	const rootName = basename(root);
	if (!isSafeFlatName(rootName)) throw new Error("Problem directory name must be a flat ASCII name.");

	const files = new Map<string, Uint8Array>();
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isFile()) {
			files.set(entry.name, await readFile(join(root, entry.name)));
			continue;
		}
		if (!entry.isDirectory() || (entry.name !== "testdata" && entry.name !== "additional_file")) {
			throw new Error(`Unsafe entry appeared after validation: ${entry.name}`);
		}
		for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
			if (!child.isFile()) throw new Error(`Unsafe entry appeared after validation: ${entry.name}/${child.name}`);
			files.set(`${entry.name}/${child.name}`, await readFile(join(root, entry.name, child.name)));
		}
	}
	return buildStoredArchive(rootName, files);
}
