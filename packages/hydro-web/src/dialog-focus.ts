import type { KeyboardEvent } from "react";

export function containDialogTab(event: KeyboardEvent<HTMLDialogElement>): void {
	if (event.key !== "Tab") return;
	const focusable = [
		...event.currentTarget.querySelectorAll<HTMLElement>(
			"button, a[href], input, select, textarea, summary, [tabindex], [contenteditable=true]",
		),
	].filter((element) => {
		const closedDetails = element.closest("details:not([open])");
		return (
			element.tabIndex >= 0 &&
			!element.matches(":disabled") &&
			!element.closest("[inert]") &&
			element.getClientRects().length > 0 &&
			(!closedDetails || !!closedDetails.querySelector(":scope > summary")?.contains(element))
		);
	});
	const first = focusable[0],
		last = focusable.at(-1);
	if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
		event.preventDefault();
		(event.shiftKey ? last : first)?.focus();
	}
}
