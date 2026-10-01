export interface TransferProgress {
	phase: "reading" | "uploading" | "saving";
	file?: string;
	loaded?: number;
	total?: number;
}
export interface FileTransfer extends TransferProgress {
	name: string;
	state: "running" | "done" | "failed";
	error?: string;
}
type Reporter = (progress: TransferProgress) => void;
let current: FileTransfer | undefined;
let generation = 0;
const listeners = new Set<() => void>();
function publish(value?: FileTransfer) {
	current = value;
	for (const listener of listeners) listener();
}
export const transfers = {
	getSnapshot: () => current,
	subscribe(listener: () => void) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
	clear() {
		generation++;
		publish();
	},
};

export async function transferFiles<T>(
	name: string,
	work: (report: Reporter) => Promise<T>,
	replace = false,
): Promise<T> {
	if (current?.state === "running" && !replace) throw new Error("请等待当前文件处理完成。");
	const id = ++generation;
	publish({ name, state: "running", phase: "reading" });
	const report: Reporter = (progress) => {
		if (id === generation && current?.state === "running") publish({ name, state: "running", ...progress });
	};
	try {
		const result = await work(report);
		if (id === generation) publish({ name, state: "done", phase: current?.phase ?? "saving", loaded: 1, total: 1 });
		return result;
	} catch (error) {
		if (id === generation)
			publish({
				name,
				state: "failed",
				phase: current?.phase ?? "saving",
				error: error instanceof Error ? error.message : "文件处理失败。",
			});
		throw error;
	}
}

export function readFileWithProgress(
	file: File,
	onProgress: (loaded: number) => void,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		const abort = () => reader.abort();
		const cleanup = () => signal?.removeEventListener("abort", abort);
		reader.onprogress = (event) => onProgress(event.loaded);
		reader.onload = () => {
			cleanup();
			onProgress(file.size);
			if (reader.result instanceof ArrayBuffer) resolve(reader.result);
			else reject(new Error("文件读取失败。"));
		};
		reader.onerror = () => {
			cleanup();
			reject(new Error("文件读取失败。"));
		};
		reader.onabort = () => {
			cleanup();
			reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
		};
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		reader.readAsArrayBuffer(file);
	});
}

export async function readSourceFile(file: File, signal?: AbortSignal): Promise<string> {
	return transferFiles(
		file.name,
		async (report) => {
			const text = new TextDecoder().decode(
				await readFileWithProgress(
					file,
					(loaded) => report({ phase: "reading", file: file.name, loaded, total: file.size }),
					signal,
				),
			);
			signal?.throwIfAborted();
			return text;
		},
		true,
	);
}
