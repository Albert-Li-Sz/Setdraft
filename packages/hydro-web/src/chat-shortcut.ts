export function shouldSendChatMessage(event: {
	key: string;
	shiftKey: boolean;
	isComposing: boolean;
	repeat: boolean;
	keyCode?: number;
}): boolean {
	return event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat && event.keyCode !== 229;
}
