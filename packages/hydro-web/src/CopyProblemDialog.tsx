import { useEffect, useState } from "react";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import { apiUrl, requestJson } from "./platform.ts";

export function CopyProblemDialog({
	apiOrigin,
	title,
	onClose,
	onCopy,
}: {
	apiOrigin: string;
	title: string;
	onClose(): void;
	onCopy(recipientId: string): Promise<void>;
}) {
	const { t } = useLocale();
	const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
	const [recipient, setRecipient] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		void requestJson<{ users: Array<{ id: string; username: string }> }>(apiUrl(apiOrigin, "/people"), {
			signal: controller.signal,
		})
			.then((value) => {
				if (!controller.signal.aborted) setUsers(value.users);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "用户列表读取失败。");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [apiOrigin]);
	return (
		<Dialog
			open
			onClose={() => {
				if (!busy) onClose();
			}}
			labelledBy="copy-problem-title"
		>
			<div className="confirmation-heading">
				<h2 id="copy-problem-title">{t("复制给其他用户")}</h2>
			</div>
			<p className="dialog-subtitle">{title || t("未命名题目")}</p>
			{done ? (
				<>
					<output>
						{t("已复制到 {0} 的题目中心。", users.find((user) => user.id === recipient)?.username ?? "")}
					</output>
					<div className="confirmation-actions">
						<button className="button primary" type="button" onClick={onClose}>
							{t("完成")}
						</button>
					</div>
				</>
			) : (
				<form
					className="account-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy) return;
						setBusy(true);
						setError("");
						void onCopy(recipient)
							.then(() => setDone(true))
							.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "复制失败。"))
							.finally(() => setBusy(false));
					}}
				>
					<p>{t("复制当前题目、代码、附件和测试数据，不包含历史发布包。双方后续修改互不影响。")}</p>
					<label>
						{t("接收用户")}
						<select
							required
							value={recipient}
							disabled={loading || busy}
							onChange={(event) => setRecipient(event.target.value)}
						>
							<option value="">{t(loading ? "正在读取用户…" : "选择用户")}</option>
							{users.map((user) => (
								<option key={user.id} value={user.id}>
									{user.username}
								</option>
							))}
						</select>
					</label>
					{!loading && !users.length && !error && <p>{t("暂无可接收的其他用户。")}</p>}
					{error && (
						<output className="auth-error" role="alert">
							{t(error)}
						</output>
					)}
					<div className="confirmation-actions">
						<button className="button secondary" type="button" disabled={busy} onClick={onClose}>
							{t("取消")}
						</button>
						<button className="button primary" type="submit" disabled={loading || busy || !recipient}>
							{t(busy ? "复制中…" : "确认复制")}
						</button>
					</div>
				</form>
			)}
		</Dialog>
	);
}
