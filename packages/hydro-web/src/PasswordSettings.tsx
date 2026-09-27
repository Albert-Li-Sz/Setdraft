import { useState } from "react";
import { authClient } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";

export function PasswordSettings() {
	const { t } = useLocale();
	const [changing, setChanging] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [password, setPassword] = useState("");
	const [message, setMessage] = useState("");
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	return (
		<section className="profile-section">
			<div className="preference-row">
				<div>
					<h2>{t("账号安全")}</h2>
					<p className="settings-help">{t("修改密码后，其他设备需要重新登录。")}</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() => {
						setMessage("");
						setSaved(false);
						setChanging(true);
					}}
				>
					{t("修改密码")}
				</button>
			</div>
			{saved && <output className="settings-help">{t("密码已更新。")}</output>}

			<Dialog
				open={changing}
				onClose={() => {
					if (!busy) {
						setChanging(false);
						setPassword("");
						setCurrentPassword("");
					}
				}}
				labelledBy="password-title"
			>
				<div className="confirmation-heading">
					<h2 id="password-title">{t("修改密码")}</h2>
				</div>
				<form
					className="account-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy) return;
						setBusy(true);
						setMessage("");
						void authClient
							.changePassword(currentPassword, password)
							.then(() => {
								setSaved(true);
								setChanging(false);
								setPassword("");
								setCurrentPassword("");
							})
							.catch((error: unknown) => setMessage(error instanceof Error ? error.message : "修改密码失败。"))
							.finally(() => setBusy(false));
					}}
				>
					<label>
						{t("当前密码")}
						<input
							type="password"
							autoComplete="current-password"
							required
							disabled={busy}
							value={currentPassword}
							onChange={(event) => setCurrentPassword(event.target.value)}
						/>
					</label>
					<label>
						{t("新密码")}
						<input
							type="password"
							autoComplete="new-password"
							required
							disabled={busy}
							minLength={15}
							maxLength={128}
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</label>
					<small>{t("密码须为 15–128 个字符。")}</small>
					{message && (
						<output className="auth-error" role="alert">
							{t(message)}
						</output>
					)}
					<div className="confirmation-actions">
						<button
							type="button"
							className="button secondary"
							disabled={busy}
							onClick={() => {
								setChanging(false);
								setPassword("");
								setCurrentPassword("");
							}}
						>
							{t("取消")}
						</button>
						<button className="button primary" type="submit" disabled={busy}>
							{t("保存密码")}
						</button>
					</div>
				</form>
			</Dialog>
		</section>
	);
}
