import type { AuthUser } from "@hydro-problem-make/contracts";
import { useRef, useState } from "react";
import { authClient } from "./auth-client.ts";
import { type Locale, useLocale } from "./i18n.tsx";
import { UserAvatar } from "./UserAvatar.tsx";

async function avatarFromFile(file: File): Promise<string> {
	if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
		throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
	if (file.size > 5 * 1024 * 1024) throw new Error("头像原图不能超过 5 MiB。");
	const bitmap = await createImageBitmap(file);
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 256;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("无法处理头像图片。");
		const size = Math.min(bitmap.width, bitmap.height);
		context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
		return canvas.toDataURL("image/webp", 0.85);
	} finally {
		bitmap.close();
	}
}

export function SettingsPage({ user }: { user: AuthUser }) {
	const { t } = useLocale();
	const [language, setLanguage] = useState<Locale>(user.locale ?? "zh-CN");
	const [avatar, setAvatar] = useState(user.avatar);
	const [busy, setBusy] = useState(false);
	const [processing, setProcessing] = useState(false);
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	const upload = useRef<HTMLInputElement>(null);
	const dirty = language !== (user.locale ?? "zh-CN") || avatar !== user.avatar;
	return (
		<main className="page personal-settings" id="settings">
			<section className="page-heading">
				<div>
					<h1>{t("个人设置")}</h1>
					<p>{t("管理你的头像和语言偏好。")}</p>
				</div>
			</section>
			<form
				className="personal-settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (busy || processing) return;
					setBusy(true);
					setMessage("");
					void authClient
						.updateProfile({ locale: language, avatar: avatar ?? null })
						.then(() => {
							setMessage("个人设置已保存。");
							setFailed(false);
						})
						.catch((cause: unknown) => {
							setMessage(cause instanceof Error ? cause.message : "设置保存失败。");
							setFailed(true);
						})
						.finally(() => setBusy(false));
				}}
			>
				<section className="profile-section">
					<h2>{t("个人资料")}</h2>
					<div className="profile-avatar-row">
						<UserAvatar user={{ username: user.username, avatar }} large />
						<div className="profile-avatar-actions">
							<strong>{user.username}</strong>
							<span>{t(user.role === "admin" ? "管理员" : "成员")}</span>
							<div className="heading-actions">
								<button
									className="button secondary"
									type="button"
									disabled={busy || processing}
									onClick={() => upload.current?.click()}
								>
									{t(processing ? "处理图片中…" : "更新头像")}
								</button>
								{avatar && (
									<button
										className="text-button"
										type="button"
										disabled={busy || processing}
										onClick={() => setAvatar(undefined)}
									>
										{t("移除头像")}
									</button>
								)}
							</div>
						</div>
					</div>
					<input
						className="visually-hidden"
						ref={upload}
						type="file"
						aria-label={t("上传头像")}
						accept="image/png,image/jpeg,image/webp"
						disabled={busy || processing}
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (!file) return;
							setProcessing(true);
							setMessage("");
							void avatarFromFile(file)
								.then(setAvatar)
								.catch((cause: unknown) => {
									setMessage(cause instanceof Error ? cause.message : "无法处理头像图片。");
									setFailed(true);
								})
								.finally(() => setProcessing(false));
						}}
					/>
					<p className="settings-help">{t("PNG、JPEG 或 WebP，最大 5 MiB。自动居中裁剪为方形。")}</p>
				</section>
				<section className="profile-section">
					<div className="preference-row">
						<div>
							<h2>{t("语言偏好")}</h2>
							<p className="settings-help">{t("保存在账号中，下次登录自动应用。")}</p>
						</div>
						<select
							aria-label={t("语言偏好")}
							value={language}
							onChange={(event) => setLanguage(event.target.value as Locale)}
							disabled={busy}
						>
							<option value="zh-CN">简体中文</option>
							<option value="en">English</option>
						</select>
					</div>
				</section>
				<div className="profile-save-row">
					<output className={failed ? "auth-error" : "settings-help"}>{t(message)}</output>
					<button type="submit" className="button primary" disabled={busy || processing || !dirty}>
						{t(busy ? "保存中…" : "保存设置")}
					</button>
				</div>
			</form>
		</main>
	);
}
