import type { AuthUser } from "@setdraft/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { App } from "./App.tsx";
import { type AuthState, authClient } from "./auth-client.ts";
import { Icon } from "./Icon.tsx";
import { LocaleSwitcher, useLocale } from "./i18n.tsx";
import { ThemeSwitcher } from "./theme.tsx";
import { appVersion } from "./version.ts";
import { WorkspacePausedContext } from "./workspace-paused.ts";

function AuthScreen({ state }: { state: AuthState }) {
	const { t } = useLocale();
	const [username, setUsername] = useState(state.user?.username ?? "");
	const [password, setPassword] = useState("");
	const [nextPassword, setNextPassword] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const setup = state.setupRequired;
	const change = state.status === "ready" && state.user?.mustChangePassword;
	const title = change
		? "设置你的密码"
		: setup
			? "创建管理员"
			: state.status === "locked"
				? "重新登录"
				: "登录 Setdraft";
	return (
		<main className="auth-page">
			<header className="auth-header">
				<a href="#workspace" className="sidebar-brand">
					Setdraft <small className="brand-version">{appVersion}</small>
				</a>
				<div className="shell-toolbar-tools">
					<ThemeSwitcher />
					<LocaleSwitcher />
				</div>
			</header>
			<div className="auth-layout">
				<aside className="auth-intro">
					<span className="auth-intro-label">SETDRAFT / WORKSPACE</span>
					<Icon name="layers" />
					<h2>{t("编写，验证，发布。")}</h2>
					<p>{t("从题面与数据，到标程、验证与发布。")}</p>
					<div className="auth-workflow" aria-hidden="true">
						<span>{t("题面")}</span>
						<span>{t("测试数据")}</span>
						<span>{t("验证")}</span>
						<span>{t("发布")}</span>
					</div>
				</aside>
				<section className="auth-card" aria-labelledby="auth-title">
					<div className="auth-mark" aria-hidden="true">
						S
					</div>
					<h1 id="auth-title">{t(title)}</h1>
					<p>
						{t(
							change
								? "首次登录或密码重置后，请设置新的密码。"
								: setup
									? "输入服务启动时显示的一次性安装码。"
									: state.status === "locked"
										? "使用同一账号登录，继续未保存的编辑。"
										: "进入你的个人工作区。",
						)}
					</p>
					{state.status === "loading" ? (
						<output>{t("正在连接…")}</output>
					) : state.status === "error" ? (
						<>
							<output role="alert">{t(state.message ?? "无法连接登录服务，请重试。")}</output>
							<button className="button primary" type="button" onClick={() => void authClient.refresh()}>
								{t("重试")}
							</button>
						</>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								setBusy(true);
								setError("");
								void (
									change
										? authClient.changePassword(password, nextPassword)
										: authClient.authenticate(setup ? "setup" : "login", { username, password, setupToken })
								)
									.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "登录失败。"))
									.finally(() => {
										setBusy(false);
										setPassword("");
										setNextPassword("");
									});
							}}
						>
							{setup && (
								<label>
									{t("安装码")}
									<input
										autoComplete="off"
										value={setupToken}
										onChange={(event) => setSetupToken(event.target.value)}
										required
									/>
								</label>
							)}
							{!change && (
								<label>
									{t("用户名")}
									<input
										name="username"
										autoComplete="username"
										autoCapitalize="none"
										spellCheck={false}
										value={username}
										onChange={(event) => setUsername(event.target.value)}
										required
										minLength={3}
										maxLength={32}
									/>
								</label>
							)}
							<label>
								{t(change ? "临时密码" : "密码")}
								<input
									name="password"
									type="password"
									autoComplete={setup ? "new-password" : "current-password"}
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									required
									maxLength={128}
									minLength={setup ? 15 : undefined}
								/>
							</label>
							{change && (
								<label>
									{t("新密码")}
									<input
										type="password"
										autoComplete="new-password"
										value={nextPassword}
										onChange={(event) => setNextPassword(event.target.value)}
										required
										minLength={15}
										maxLength={128}
									/>
								</label>
							)}
							{(change || setup) && <small>{t("密码须为 15–128 个字符。")}</small>}
							{error && (
								<output className="auth-error" role="alert">
									{t(error)}
								</output>
							)}
							<button className="button primary" type="submit" disabled={busy}>
								{t(busy ? "请稍候…" : change ? "保存密码" : setup ? "创建并进入" : "登录")}
							</button>
							{change && (
								<button
									className="button secondary"
									type="button"
									disabled={busy}
									onClick={() =>
										void authClient
											.logout()
											.catch((cause: unknown) =>
												setError(cause instanceof Error ? cause.message : "退出失败。"),
											)
									}
								>
									{t("退出登录")}
								</button>
							)}
						</form>
					)}
				</section>
			</div>
			<footer className="auth-footer">{t("个人内容独立保存 · AI 由管理员提供")}</footer>
		</main>
	);
}

export function AuthRoot() {
	const { setLocale } = useLocale();
	const state = useSyncExternalStore(authClient.subscribe, authClient.getSnapshot);
	useEffect(() => {
		if (state.user?.id) setLocale(state.user?.locale ?? "zh-CN");
	}, [state.user?.id, state.user?.locale, setLocale]);
	useEffect(() => {
		authClient.start();
	}, []);
	useEffect(() => {
		const verify = () => {
			if (document.visibilityState === "visible") void authClient.refresh();
		};
		window.addEventListener("focus", verify);
		document.addEventListener("visibilitychange", verify);
		return () => {
			window.removeEventListener("focus", verify);
			document.removeEventListener("visibilitychange", verify);
		};
	}, []);
	const [retainedUser, setRetainedUser] = useState<AuthUser | null>(null);
	useEffect(() => {
		if (state.status === "ready" && state.user && !state.user.mustChangePassword) setRetainedUser(state.user);
		else if (state.user?.id !== retainedUser?.id) setRetainedUser(null);
	}, [state.status, state.user, retainedUser]);
	const workspaceUser =
		state.user && !state.user.mustChangePassword
			? state.user
			: retainedUser?.id === state.user?.id
				? retainedUser
				: null;
	const locked = state.status !== "ready" || Boolean(state.user?.mustChangePassword);
	return (
		<>
			{workspaceUser && (
				<div hidden={locked} inert={locked} aria-hidden={locked}>
					<WorkspacePausedContext value={locked}>
						<App key={workspaceUser.id} user={workspaceUser} paused={locked} />
					</WorkspacePausedContext>
				</div>
			)}
			{locked && (
				<AuthScreen
					key={`${state.user?.id ?? "guest"}:${state.setupRequired}:${state.user?.mustChangePassword}`}
					state={state}
				/>
			)}
		</>
	);
}
