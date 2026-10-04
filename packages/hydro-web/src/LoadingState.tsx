import { Icon } from "./Icon.tsx";

export function LoadingState({ label }: { label: string }) {
	return (
		<output className="loading-state">
			<Icon name="loader" className="loading-icon" />
			<span>{label}</span>
		</output>
	);
}
