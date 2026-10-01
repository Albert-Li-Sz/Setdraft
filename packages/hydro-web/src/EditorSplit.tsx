import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { useLocale } from "./i18n.tsx";

export function EditorSplit({ children }: { children: ReactNode[] }) {
	const { t } = useLocale();
	const [split, setSplit] = useState(50);
	const [pane, setPane] = useState("editor");
	const ref = useRef<HTMLDivElement>(null);
	const clamp = (value: number) => Math.max(20, Math.min(80, value));
	return (
		<div className="statement-split" data-pane={pane}>
			<nav className="statement-view-switch" aria-label={t("题面视图")}>
				<button
					className="button secondary"
					type="button"
					aria-pressed={pane === "editor"}
					onClick={() => setPane("editor")}
				>
					{t("编辑")}
				</button>
				<button
					className="button secondary"
					type="button"
					aria-pressed={pane === "preview"}
					onClick={() => setPane("preview")}
				>
					{t("预览")}
				</button>
			</nav>
			<div className="editor-grid" ref={ref} style={{ "--editor-split": `${split}%` } as CSSProperties}>
				{children[0]}
				<hr
					className="editor-resizer"
					aria-orientation="vertical"
					aria-label={t("调整编辑与预览宽度")}
					aria-valuemin={20}
					aria-valuemax={80}
					aria-valuenow={Math.round(split)}
					tabIndex={0}
					onPointerDown={(event) => {
						event.preventDefault();
						event.currentTarget.setPointerCapture(event.pointerId);
					}}
					onPointerMove={(event) => {
						if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
						const bounds = ref.current?.getBoundingClientRect();
						if (bounds?.width) setSplit(clamp(((event.clientX - bounds.left) / bounds.width) * 100));
					}}
					onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
					onDoubleClick={() => setSplit(50)}
					onKeyDown={(event) => {
						if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						setSplit((value) =>
							event.key === "Home"
								? 20
								: event.key === "End"
									? 80
									: clamp(value + (event.key === "ArrowLeft" ? -2 : 2)),
						);
					}}
				/>
				{children[1]}
			</div>
		</div>
	);
}
