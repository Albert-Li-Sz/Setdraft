import type { AuthUser } from "@hydro-problem-make/contracts";
import { useState } from "react";
import { authClient } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";

export function AccountControls({ user, onLogout }: { user: AuthUser; onLogout(): Promise<void> }) {
	const { t } = useLocale();
	const [changing, setChanging] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [password, setPassword] = useState("");
	const [message, setMessage] = useState("");
	const [logoutError, setLogoutError] = useState("");
	const [busy, setBusy] = useState(false);
	const logout = async () => {
		setBusy(true);
		try {
			await onLogout();
		} catch (error) {
			setLogoutError(error instanceof Error ? error.message : "退出失败。");
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<details className="account-menu">
				<summary className="sidebar-workspace account-trigger">
					<span className="workspace-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
					<span className="account-identity">
						<strong>{user.username}</strong>
						<small>{t(user.role === "admin" ? "管理员" : "成员")}</small>
					</span>
					<span aria-hidden="true">⌃</span>
				</summary>
				<div className="account-popover">
					<button
						type="button"
						onClick={() => {
							setMessage("");
							setChanging(true);
						}}
					>
						{t("修改密码")}
					</button>
					<button type="button" disabled={busy} onClick={() => void logout()}>
						{t("退出登录")}
					</button>
				</div>
			</details>
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
						setBusy(true);
						setMessage("");
						void authClient
							.changePassword(currentPassword, password)
							.then(() => {
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
			<Dialog open={Boolean(logoutError)} onClose={() => setLogoutError("")} labelledBy="logout-title">
				<div className="confirmation-heading">
					<h2 id="logout-title">{t("草稿尚未保存")}</h2>
				</div>
				<p>{t(logoutError)}</p>
				<p>{t("可以返回继续编辑，或放弃未保存的修改并退出。")}</p>
				<div className="confirmation-actions">
					<button className="button secondary" type="button" onClick={() => setLogoutError("")}>
						{t("继续编辑")}
					</button>
					<button
						className="button primary"
						type="button"
						onClick={() =>
							void authClient
								.logout()
								.catch((error: unknown) =>
									setLogoutError(error instanceof Error ? error.message : "退出失败。"),
								)
						}
					>
						{t("放弃修改并退出")}
					</button>
				</div>
			</Dialog>
		</>
	);
}
