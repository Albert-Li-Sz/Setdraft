import { type ReactNode, useContext, useEffect, useRef } from "react";

import { WorkspacePausedContext } from "./workspace-paused.ts";

export function Dialog({
	open: requestedOpen,
	onClose,
	labelledBy,
	children,
	className = "",
}: {
	open: boolean;
	onClose(): void;
	labelledBy: string;
	children: ReactNode;
	className?: string;
}) {
	const paused = useContext(WorkspacePausedContext);
	const open = requestedOpen && !paused;
	const ref = useRef<HTMLDialogElement>(null);
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
			if (!open) dialog.close();
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
				if (!open) dialog.close();
			})
			.catch(() => {
				/* A rapid reopen cancels the previous transition. */
			});
		return () => animation.cancel();
	}, [open, paused]);
	return (
		<dialog
			ref={ref}
			className={`card confirmation-dialog motion-dialog ${className}`}
			aria-labelledby={labelledBy}
			data-closing={!open}
			inert={!open}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onKeyDown={(event) => {
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
