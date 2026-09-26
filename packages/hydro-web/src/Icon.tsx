const paths = {
	arrow: "M4 12h16m-6-6 6 6-6 6",
	plus: "M12 5v14M5 12h14",
	file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M9 13h6m-6 4h6",
	check: "m5 12 4 4L19 6",
	layers: "m12 3 10 6-10 6L2 9l10-6Zm-10 12 10 6 10-6M2 12l10 6 10-6",
	code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
	spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
	grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
	files: "M8 3h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 8v12a2 2 0 0 0 2 2h10M10 8h7m-7 4h5",
	chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l1.8-4.2A8.5 8.5 0 1 1 21 11.5ZM8 9h8m-8 4h5",
	terminal: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4 3 3-3 3m6 1h4",
	activity: "M3 12h4l3-7 4 14 3-7h4",
	loader: "M12 3a9 9 0 1 1-9 9",
};

export function Icon({ name, className }: { name: keyof typeof paths; className?: string }) {
	return (
		<svg
			className={className}
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}
