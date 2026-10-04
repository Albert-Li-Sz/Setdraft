import { type ReactNode, useContext, useEffect, useEffectEvent, useRef } from "react";
import { containDialogTab } from "./dialog-focus.ts";

import { WorkspacePausedContext } from "./workspace-paused.ts";

export function Dialog({
	open: requestedOpen,
	onClose,
	onClosed,
	labelledBy,
	children,
	className = "",
	role = "dialog",
}: {
	open: boolean;
	onClose(): void;
	onClosed?(): void;
	labelledBy: string;
	children: ReactNode;
	className?: string;
	role?: "dialog" | "alertdialog";
}) {
	const paused = useContext(WorkspacePausedContext);
	const open = requestedOpen && !paused;
	const ref = useRef<HTMLDialogElement>(null);
	const notifyClosed = useEffectEvent(() => onClosed?.());
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (paused) {
			dialog.close();
			return;
		}
		if (open && !dialog.open) dialog.showModal();
		if (!dialog.open) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			if (!open) {
				dialog.close();
				notifyClosed();
			}
			return;
		}
		const animation = dialog.animate(
			open
				? [
						{ opacity: 0, transform: "translateY(4px) scale(0.99)" },
						{ opacity: 1, transform: "translateY(0) scale(1)" },
					]
				: [
						{ opacity: 1, transform: "translateY(0) scale(1)" },
						{ opacity: 0, transform: "translateY(3px) scale(0.99)" },
					],
			{ duration: open ? 200 : 120, easing: open ? "cubic-bezier(0.16, 1, 0.3, 1)" : "ease-in", fill: "forwards" },
		);
		void animation.finished
			.then(() => {
				if (!open) {
					dialog.close();
					notifyClosed();
				}
			})
			.catch(() => {
				/* A rapid reopen cancels the previous transition. */
			});
		return () => animation.cancel();
	}, [open, paused]);
	return (
		<dialog
			ref={ref}
			role={role}
			className={`card confirmation-dialog motion-dialog ${className}`}
			aria-labelledby={labelledBy}
			data-closing={!open}
			inert={!open}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onKeyDown={(event) => {
				containDialogTab(event);
				if (event.key === "Escape") {
					event.preventDefault();
					onClose();
				}
			}}
			onClick={(event) => {
				if (event.target !== event.currentTarget) return;
				const bounds = event.currentTarget.getBoundingClientRect();
				if (
					event.clientX < bounds.left ||
					event.clientX > bounds.right ||
					event.clientY < bounds.top ||
					event.clientY > bounds.bottom
				)
					onClose();
			}}
		>
			{children}
		</dialog>
	);
}
