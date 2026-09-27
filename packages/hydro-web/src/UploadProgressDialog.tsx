import { useSyncExternalStore } from "react";
import { Dialog } from "./Dialog.tsx";
import { transfers } from "./file-transfer.ts";
import { useLocale } from "./i18n.tsx";

export function UploadProgressDialog() {
	const transfer = useSyncExternalStore(transfers.subscribe, transfers.getSnapshot);
	const { t } = useLocale();
	const running = transfer?.state === "running";
	const percent = transfer?.total
		? Math.min(100, Math.round(((transfer.loaded ?? 0) / transfer.total) * 100))
		: undefined;
	const label =
		transfer?.state === "failed"
			? "文件处理失败"
			: transfer?.state === "done"
				? "文件处理完成"
				: transfer?.phase === "reading"
					? "正在读取文件"
					: transfer?.phase === "saving"
						? "正在保存文件"
						: "正在上传文件";
	return (
		<Dialog
			open={!!transfer}
			onClose={() => {
				if (!running) transfers.clear();
			}}
			labelledBy="upload-progress-title"
			className="upload-progress-dialog"
		>
			<h2 id="upload-progress-title">{t(label)}</h2>
			<p className="transfer-filename">{transfer?.file || transfer?.name}</p>
			<progress
				max={100}
				value={running && transfer?.phase === "saving" ? undefined : percent}
				aria-label={t(label)}
			/>
			<output aria-live="polite">
				{transfer?.error
					? t(transfer.error)
					: running && transfer?.phase === "saving"
						? t("上传完成，正在等待服务端保存…")
						: percent === undefined
							? t("请稍候…")
							: `${percent}%`}
			</output>
			<div className="confirmation-actions">
				<button type="button" className="button secondary" disabled={running} onClick={() => transfers.clear()}>
					{t("关闭")}
				</button>
			</div>
		</Dialog>
	);
}
