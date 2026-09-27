export type UploadProgress = (loaded: number, total?: number) => void;
export type ProgressRequestInit = RequestInit & { onUploadProgress?: UploadProgress };

/** XHR supplies upload byte counts; authentication and response validation stay in AuthClient. */
export function uploadRequest(url: string, init: RequestInit, progress: UploadProgress): Promise<Response> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const cleanup = () => init.signal?.removeEventListener("abort", abort);
		xhr.open(init.method ?? "POST", url);
		xhr.responseType = "arraybuffer";
		xhr.withCredentials = init.credentials === "include";
		new Headers(init.headers).forEach((value, key) => {
			xhr.setRequestHeader(key, value);
		});
		xhr.upload.onprogress = (event) => progress(event.loaded, event.lengthComputable ? event.total : undefined);
		xhr.onload = () => {
			cleanup();
			try {
				const headers = new Headers();
				for (const line of xhr
					.getAllResponseHeaders()
					.trim()
					.split(/[\r\n]+/u)) {
					const colon = line.indexOf(":");
					if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
				}
				resolve(
					new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, {
						status: xhr.status,
						headers,
					}),
				);
			} catch (error) {
				reject(error);
			}
		};
		xhr.onerror = () => {
			cleanup();
			reject(new Error("文件上传失败，请检查网络连接。"));
		};
		xhr.onabort = () => {
			cleanup();
			reject(init.signal?.reason ?? new DOMException("Upload cancelled", "AbortError"));
		};
		if (init.signal?.aborted) {
			reject(init.signal.reason);
			return;
		}
		init.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (init.body instanceof ReadableStream) throw new Error("上传不支持流式请求体。");
			xhr.send(init.body ?? null);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
