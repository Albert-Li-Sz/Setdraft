export function createClientId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	// getRandomValues remains available on HTTP origins where randomUUID is absent.
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const active = document.activeElement;
	const selection = document.getSelection();
	const ranges = selection
		? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
		: [];
	const input = document.createElement("textarea");
	input.value = text;
	input.readOnly = true;
	input.tabIndex = -1;
	input.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
	document.body.append(input);
	try {
		input.focus({ preventScroll: true });
		input.select();
		if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
	} finally {
		input.remove();
		if (active instanceof HTMLElement) active.focus({ preventScroll: true });
		if (selection) {
			selection.removeAllRanges();
			for (const range of ranges) selection.addRange(range);
		}
	}
}
