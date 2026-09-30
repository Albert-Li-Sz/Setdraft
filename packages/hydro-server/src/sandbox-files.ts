import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface SandboxFileBudget {
	remainingBytes: number;
}

/** Only import after every container writing this root has exited. Keep opened directories pinned on Linux. */
async function openSandboxFile(root: string, name: string): Promise<{ file: FileHandle; close(): Promise<void> }> {
	const parts = name.split("/");
	if (isAbsolute(name) || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
		throw new Error("沙箱输出路径无效。");
	const handles: FileHandle[] = [];
	try {
		const metadata = await lstat(root);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("沙箱输出根目录无效。");
		let path = await realpath(root);
		const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
		let directory = await open(path, directoryFlags);
		handles.push(directory);
		const openedRoot = await directory.stat();
		if (openedRoot.dev !== metadata.dev || openedRoot.ino !== metadata.ino) throw new Error("沙箱输出目录已变化。");
		for (const part of parts.slice(0, -1)) {
			path = join(process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : path, part);
			directory = await open(path, directoryFlags);
			handles.push(directory);
		}
		path = join(process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : path, parts.at(-1)!);
		const before = await lstat(path);
		if (!before.isFile() || before.nlink !== 1) throw new Error("沙箱输出必须是无链接的普通文件。");
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		handles.push(file);
		const after = await file.stat();
		if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino)
			throw new Error("沙箱输出文件已变化。");
		return {
			file,
			close: async () => {
				for (const handle of handles.reverse()) await handle.close();
			},
		};
	} catch (error) {
		for (const handle of handles.reverse()) await handle.close();
		throw error;
	}
}

async function consumeSandboxFile(
	root: string,
	name: string,
	maxBytes: number,
	budget: SandboxFileBudget,
	consume: (chunk: Buffer) => Promise<void>,
	signal?: AbortSignal,
): Promise<number> {
	signal?.throwIfAborted();
	const source = await openSandboxFile(root, name);
	try {
		const size = (await source.file.stat()).size;
		if (size > maxBytes || size > budget.remainingBytes) throw new Error("沙箱输出超过容量上限。");
		const buffer = Buffer.alloc(64 * 1024);
		let bytes = 0;
		for (;;) {
			signal?.throwIfAborted();
			const result = await source.file.read(buffer, 0, buffer.length, bytes);
			if (!result.bytesRead) break;
			bytes += result.bytesRead;
			budget.remainingBytes -= result.bytesRead;
			if (bytes > maxBytes || budget.remainingBytes < 0) throw new Error("沙箱输出超过容量上限。");
			await consume(buffer.subarray(0, result.bytesRead));
		}
		return bytes;
	} finally {
		await source.close();
	}
}

export async function readSandboxFile(
	root: string,
	name: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await consumeSandboxFile(
		root,
		name,
		maxBytes,
		{ remainingBytes: maxBytes },
		async (chunk) => {
			chunks.push(Buffer.from(chunk));
		},
		signal,
	);
	return Buffer.concat(chunks);
}

export async function copySandboxFile(
	root: string,
	name: string,
	target: string,
	maxBytes: number,
	budget: SandboxFileBudget,
	signal?: AbortSignal,
): Promise<number> {
	const output = await open(
		target,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		return await consumeSandboxFile(
			root,
			name,
			maxBytes,
			budget,
			async (chunk) => {
				let offset = 0;
				while (offset < chunk.length)
					offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
			},
			signal,
		);
	} finally {
		await output.close();
	}
}
