export async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
	signal.throwIfAborted();
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([Promise.resolve().then(operation), cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
