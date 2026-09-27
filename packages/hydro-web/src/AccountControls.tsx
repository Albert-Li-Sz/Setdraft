import type { AuthUser } from "@setdraft/contracts";
import { useState } from "react";
import { authClient } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import { UserAvatar } from "./UserAvatar.tsx";

export function AccountControls({ user, onLogout }: { user: AuthUser; onLogout(): Promise<void> }) {
	const { t } = useLocale();
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
					<UserAvatar user={user} />
					<span className="account-identity">
						<strong>{user.username}</strong>
						<small>{t(user.role === "admin" ? "管理员" : "成员")}</small>
					</span>
					<span aria-hidden="true">⌃</span>
				</summary>
				<div className="account-popover">
					<button type="button" disabled={busy} onClick={() => void logout()}>
						{t("退出登录")}
					</button>
				</div>
			</details>
			<Dialog open={Boolean(logoutError)} onClose={() => setLogoutError("")} labelledBy="logout-title">
				<div className="confirmation-heading">
					<h2 id="logout-title">{t("题目尚未保存")}</h2>
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
