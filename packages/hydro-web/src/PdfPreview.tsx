import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useContext, useEffect, useRef, useState } from "react";
import { authFetch } from "./auth-client.ts";
import { useLocale } from "./i18n.tsx";
import { WorkspacePausedContext } from "./workspace-paused.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ url }: { url: string }) {
	const { t } = useLocale();
	const paused = useContext(WorkspacePausedContext);
	const host = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const [document, setDocument] = useState<PDFDocumentProxy>();
	const [page, setPage] = useState(1);
	const [width, setWidth] = useState(0);
	const [rendering, setRendering] = useState(true);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setWidth(Math.max(1, element.clientWidth - 32)));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		setDocument(undefined);
		setPage(1);
		setFailed(false);
		if (paused) return;
		const controller = new AbortController();
		let loading: ReturnType<typeof getDocument> | undefined;
		void (async () => {
			const response = await authFetch(url, { signal: controller.signal });
			if (!response.ok) throw new Error("PDF unavailable");
			const data = await response.arrayBuffer();
			if (controller.signal.aborted) return;
			loading = getDocument({
				data,
				enableXfa: false,
				cMapUrl: `${window.location.origin}/pdf-assets/cmaps/`,
				cMapPacked: true,
				standardFontDataUrl: `${window.location.origin}/pdf-assets/standard_fonts/`,
				wasmUrl: `${window.location.origin}/pdf-assets/wasm/`,
			});
			const pdf = await loading.promise;
			if (!controller.signal.aborted) setDocument(pdf);
		})().catch(() => {
			if (!controller.signal.aborted) setFailed(true);
		});
		return () => {
			controller.abort();
			void loading?.destroy();
		};
	}, [url, paused]);

	useEffect(() => {
		const element = canvas.current;
		if (!document || !element || !width || paused) return;
		let cancelled = false;
		let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
		setRendering(true);
		setFailed(false);
		void document
			.getPage(page)
			.then(async (pdfPage) => {
				if (cancelled) return;
				const base = pdfPage.getViewport({ scale: 1 });
				const viewport = pdfPage.getViewport({ scale: Math.min(width / base.width, 2) });
				const ratio = Math.min(
					window.devicePixelRatio || 1,
					2,
					Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
				);
				element.width = Math.floor(viewport.width * ratio);
				element.height = Math.floor(viewport.height * ratio);
				element.style.width = `${viewport.width}px`;
				element.style.height = `${viewport.height}px`;
				task = pdfPage.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
				await task.promise;
				if (!cancelled) setRendering(false);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [document, page, width, paused]);

	const busy = !document || rendering;
	return (
		<div className="pdf-preview">
			<nav className="pdf-preview-pages" aria-label={t("PDF 页码")}>
				<button
					type="button"
					className="button secondary"
					disabled={!document || page === 1}
					onClick={() => setPage(page - 1)}
				>
					{t("上一页")}
				</button>
				<span aria-live="polite">{document ? t("第 {0} / {1} 页", page, document.numPages) : "—"}</span>
				<button
					type="button"
					className="button secondary"
					disabled={!document || page === document.numPages}
					onClick={() => setPage(page + 1)}
				>
					{t("下一页")}
				</button>
			</nav>
			<div ref={host} className="pdf-preview-viewport" aria-busy={busy && !failed}>
				{failed ? (
					<p role="alert">{t("PDF 预览失败，请下载后查看。")}</p>
				) : (
					busy && <output>{t("正在渲染 PDF…")}</output>
				)}
				<canvas
					ref={canvas}
					role="img"
					aria-label={t("PDF 第 {0} 页", page)}
					style={{ visibility: busy || failed ? "hidden" : "visible" }}
				/>
			</div>
		</div>
	);
}
