export interface PageRefresh {
	refresh(): void;
	stop(): void;
}

/** Serial reads pause in hidden/offline tabs and resume immediately when the page returns. */
export function startPageRefresh(
	read: (signal: AbortSignal) => Promise<number | false | undefined>,
	interval: number,
): PageRefresh {
	const page = typeof document === "undefined" ? undefined : document;
	const browser = typeof window === "undefined" ? undefined : window;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let pending = false;
	let failures = 0;
	const available = () => !page?.hidden && (typeof navigator === "undefined" || navigator.onLine !== false);
	const clear = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	const run = async () => {
		if (controller.signal.aborted || !available() || running) return;
		clear();
		pending = false;
		running = true;
		let delay: number | false = interval;
		try {
			delay = (await read(controller.signal)) ?? interval;
			failures = 0;
		} catch {
			// The caller owns its error message; avoid a busy retry loop during an outage.
			delay = Math.min(30000, interval * 2 ** Math.min(++failures, 5));
		} finally {
			running = false;
			if (!controller.signal.aborted && available()) {
				if (pending) {
					pending = false;
					void run();
				} else if (delay !== false) timer = setTimeout(() => void run(), delay);
			}
		}
	};
	const wake = () => {
		clear();
		if (available()) void run();
	};
	page?.addEventListener("visibilitychange", wake);
	for (const event of ["focus", "online", "offline"]) browser?.addEventListener(event, wake);
	void run();
	return {
		refresh() {
			failures = 0;
			if (running) pending = true;
			else void run();
		},
		stop() {
			controller.abort();
			clear();
			page?.removeEventListener("visibilitychange", wake);
			for (const event of ["focus", "online", "offline"]) browser?.removeEventListener(event, wake);
		},
	};
}
