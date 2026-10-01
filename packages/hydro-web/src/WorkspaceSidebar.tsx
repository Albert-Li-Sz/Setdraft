import type { ReactNode } from "react";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";

export function WorkspaceSidebar({
	compact,
	open,
	onClose,
	children,
}: {
	compact: boolean;
	open: boolean;
	onClose(): void;
	children: ReactNode;
}) {
	const { t } = useLocale();
	const contents = <aside className="manual-sidebar">{children}</aside>;
	return compact ? (
		<Dialog open={open} onClose={onClose} labelledBy="workspace-settings-title" className="workspace-settings-drawer">
			<div className="confirmation-heading">
				<h2 id="workspace-settings-title">{t("题目配置")}</h2>
				<button className="button secondary" type="button" onClick={onClose}>
					{t("关闭")}
				</button>
			</div>
			{contents}
		</Dialog>
	) : (
		contents
	);
}
