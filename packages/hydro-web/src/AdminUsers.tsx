import type { AuthUser, UserRole } from "@setdraft/contracts";
import { useCallback, useContext, useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { copyText } from "./browser-capabilities.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import { WorkspacePausedContext } from "./workspace-paused.ts";

type Pending = { user: AuthUser; action: "reset" | "toggle" | "role"; role?: UserRole };
type Credentials = { username: string; password: string };
type TemporaryCredentials = Credentials & { copyStatus: "pending" | "copying" | "copied" | "failed" };
export function AdminUsers() {
	const { t } = useLocale();
	const paused = useContext(WorkspacePausedContext);
	const [users, setUsers] = useState<AuthUser[]>([]);
	const [username, setUsername] = useState("");
	const [role, setRole] = useState<UserRole>("user");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [temporary, setTemporary] = useState<TemporaryCredentials>();
	const [pending, setPending] = useState<Pending>();
	const refresh = useCallback(async (signal?: AbortSignal) => {
		setUsers((await requestJson<{ users: AuthUser[] }>("/api/admin/users", { signal })).users);
	}, []);
	useEffect(() => {
		if (paused) return;
		const controller = new AbortController();
		setError("");
		void refresh(controller.signal).catch((cause: unknown) => {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "账号读取失败。");
		});
		return () => controller.abort();
	}, [refresh, paused]);
	const copyCredentials = useCallback(
		async (credentials: Credentials) => {
			setTemporary({ ...credentials, copyStatus: "copying" });
			let copyStatus: TemporaryCredentials["copyStatus"];
			try {
				await copyText(`${t("用户名")}: ${credentials.username}\n${t("临时密码")}: ${credentials.password}`);
				copyStatus = "copied";
			} catch {
				copyStatus = "failed";
			}
			setTemporary((current) =>
				current?.username === credentials.username && current.password === credentials.password
					? { ...current, copyStatus }
					: current,
			);
		},
		[t],
	);
	useEffect(() => {
		// Wait for the credentials dialog to open before selecting text for HTTP copying.
		if (temporary?.copyStatus === "pending") void copyCredentials(temporary);
	}, [temporary, copyCredentials]);
	const create = async () => {
		setBusy(true);
		setError("");
		try {
			const result = await requestJson<{ user: AuthUser; temporaryPassword: string }>("/api/admin/users", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username, role }),
			});
			setTemporary({ username: result.user.username, password: result.temporaryPassword, copyStatus: "pending" });
			setUsername("");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "创建账号失败。");
		} finally {
			setBusy(false);
		}
	};
	const confirm = async () => {
		if (!pending) return;
		const selected = pending;
		setPending(undefined);
		setBusy(true);
		setError("");
		try {
			if (selected.action === "reset") {
				const result = await requestJson<{ temporaryPassword: string }>(
					`/api/admin/users/${selected.user.id}/reset-password`,
					{ method: "POST" },
				);
				setTemporary({
					username: selected.user.username,
					password: result.temporaryPassword,
					copyStatus: "pending",
				});
			} else
				await requestJson(`/api/admin/users/${selected.user.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						selected.action === "role" ? { role: selected.role } : { enabled: !selected.user.enabled },
					),
				});
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "账号更新失败。");
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="card settings-card users-card">
			<div className="manual-section-heading">
				<div>
					<h2>{t("用户管理")}</h2>
					<p>{t("管理账号与访问权限，个人内容独立保存。")}</p>
				</div>
			</div>
			<form
				className="user-create-form"
				onSubmit={(event) => {
					event.preventDefault();
					void create();
				}}
			>
				<label>
					{t("用户名")}
					<input
						value={username}
						autoComplete="off"
						autoCapitalize="none"
						pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}"
						minLength={3}
						maxLength={32}
						required
						onChange={(event) => setUsername(event.target.value)}
					/>
				</label>
				<label>
					{t("角色")}
					<select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
						<option value="user">{t("成员")}</option>
						<option value="admin">{t("管理员")}</option>
					</select>
				</label>
				<button className="button primary" type="submit" disabled={busy}>
					{t("创建账号")}
				</button>
			</form>
			{error && (
				<output className="notice failed" role="alert">
					{t(error)}
				</output>
			)}
			<div className="history-table-wrap">
				<table className="history-table">
					<thead>
						<tr>
							<th>{t("用户名")}</th>
							<th>{t("角色")}</th>
							<th>{t("状态")}</th>
							<th>{t("操作")}</th>
						</tr>
					</thead>
					<tbody>
						{users.map((user) => (
							<tr key={user.id}>
								<td>
									<strong>{user.username}</strong>
									{user.mustChangePassword && <small>{t("待修改密码")}</small>}
								</td>
								<td>
									<select
										aria-label={t("{0} 的角色", user.username)}
										value={user.role}
										disabled={busy}
										onChange={(event) =>
											setPending({ user, action: "role", role: event.target.value as UserRole })
										}
									>
										<option value="user">{t("成员")}</option>
										<option value="admin">{t("管理员")}</option>
									</select>
								</td>
								<td>{t(user.enabled ? "已启用" : "已禁用")}</td>
								<td>
									<div className="history-actions">
										<button
											type="button"
											disabled={busy}
											onClick={() => setPending({ user, action: "reset" })}
										>
											{t("重置密码")}
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => setPending({ user, action: "toggle" })}
										>
											{t(user.enabled ? "禁用" : "启用")}
										</button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Dialog open={Boolean(pending)} onClose={() => setPending(undefined)} labelledBy="user-action-title">
				<div className="confirmation-heading">
					<h2 id="user-action-title">
						{t(
							pending?.action === "reset"
								? "重置密码"
								: pending?.action === "role"
									? "修改角色"
									: pending?.user.enabled
										? "禁用账号"
										: "启用账号",
						)}
					</h2>
				</div>
				<p>{pending?.user.username}</p>
				<p>
					{t(
						pending?.action === "reset"
							? "已有登录将失效，用户需要使用临时密码重新登录并改密。"
							: pending?.action === "toggle" && pending.user.enabled
								? "该账号将退出登录，未完成的任务与 AI 请求会被取消。"
								: "角色或状态更改将立即生效。",
					)}
				</p>
				<div className="confirmation-actions">
					<button className="button secondary" type="button" onClick={() => setPending(undefined)}>
						{t("取消")}
					</button>
					<button className="button primary" type="button" onClick={() => void confirm()}>
						{t("确认")}
					</button>
				</div>
			</Dialog>
			<Dialog
				open={Boolean(temporary)}
				onClose={() => setTemporary(undefined)}
				labelledBy="temporary-password-title"
			>
				<div className="confirmation-heading">
					<h2 id="temporary-password-title">{t("临时密码")}</h2>
				</div>
				<p>{temporary?.username}</p>
				<p>{t("此密码仅显示一次。请交给对应用户，首次登录时必须修改。")}</p>
				<code className="temporary-password">{temporary?.password}</code>
				<output className={`notice ${temporary?.copyStatus === "failed" ? "failed" : ""}`} aria-live="polite">
					{t(
						temporary?.copyStatus === "copied"
							? "用户名与临时密码已复制。"
							: temporary?.copyStatus === "failed"
								? "自动复制未完成，请点击下方按钮重试，或手动保存用户名与临时密码。"
								: "正在复制用户名与临时密码…",
					)}
				</output>
				<div className="confirmation-actions">
					<button
						className="button secondary"
						type="button"
						disabled={!temporary || temporary.copyStatus === "pending" || temporary.copyStatus === "copying"}
						onClick={() => temporary && void copyCredentials(temporary)}
					>
						{t("复制用户名与密码")}
					</button>
					<button className="button primary" type="button" onClick={() => setTemporary(undefined)}>
						{t("已保存")}
					</button>
				</div>
			</Dialog>
		</section>
	);
}
