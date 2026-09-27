import { Icon } from "./Icon.tsx";

export function EmptyState({
	icon,
	title,
	description,
}: {
	icon: "files" | "search" | "layers" | "activity";
	title: string;
	description: string;
}) {
	return (
		<div className="empty-state">
			<span className="empty-state-mark">
				<Icon name={icon} />
			</span>
			<h3>{title}</h3>
			<p>{description}</p>
		</div>
	);
}
