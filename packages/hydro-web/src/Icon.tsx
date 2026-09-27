const paths = {
	arrow: "M4 12h16m-6-6 6 6-6 6",
	resume: "M4 10a8 8 0 1 1 1.6 7M4 4v6h6",
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
	panel: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4 0v16",
	compose: "M13 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8M17 3l4 4-9 9-5 1 1-5 9-9Z",
	settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z",
	close: "m6 6 12 12M6 18 18 6",
	send: "M12 20V4m-6 6 6-6 6 6",
	stop: "M6 6h12v12H6V6Z",
	search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 5 5",
	eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
	attachment: "m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9",
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
