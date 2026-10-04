import type { ProtocolSample } from "@setdraft/contracts";
import { useId } from "react";
import { createClientId } from "./browser-capabilities.ts";
import { useLocale } from "./i18n.tsx";

export function ProtocolSamples({
	samples,
	communication,
	disabled,
	onChange,
}: {
	samples: ProtocolSample[];
	communication: boolean;
	disabled: boolean;
	onChange(samples: ProtocolSample[]): void;
}) {
	const { t } = useLocale();
	const prefix = useId();
	const update = (sampleIndex: number, edit: (sample: ProtocolSample) => ProtocolSample) =>
		onChange(samples.map((sample, index) => (index === sampleIndex ? edit(sample) : sample)));
	return (
		<div className="statement-samples protocol-samples">
			<p className="manual-muted">{t("协议样例是有序的公开消息，不作为私有测试点。Alt＋↑／↓ 可调整消息顺序。")}</p>
			{samples.map((sample, sampleIndex) => (
				<section className="test-card" key={sample.id ?? JSON.stringify(sample)}>
					<div className="test-card-heading">
						<strong>{t("协议样例 {0}", sampleIndex + 1)}</strong>
						<button
							type="button"
							className="text-button danger"
							disabled={disabled}
							onClick={() => onChange(samples.filter((_, index) => index !== sampleIndex))}
						>
							{t("删除")}
						</button>
					</div>
					{sample.rounds
						.filter((group) => communication || group.round === 1)
						.map((group) => (
							<fieldset key={group.round} className="protocol-round" disabled={disabled}>
								<legend>{t(communication ? (group.round === 1 ? "第一轮" : "第二轮") : "交互消息")}</legend>
								{group.messages.map((message, index) => {
									const move = (offset: number) => {
										if (index + offset < 0 || index + offset >= group.messages.length) return;
										update(sampleIndex, (current) => ({
											...current,
											rounds: current.rounds.map((item) => {
												if (item.round !== group.round) return item;
												const messages = [...item.messages];
												[messages[index], messages[index + offset]] = [
													messages[index + offset],
													messages[index],
												];
												return { ...item, messages };
											}),
										}));
										requestAnimationFrame(() =>
											document
												.getElementById(`${prefix}-${sampleIndex}-${group.round}-${index + offset}`)
												?.focus(),
										);
									};
									return (
										<div className="protocol-message" key={message.id ?? JSON.stringify(message)}>
											<div className="protocol-message-toolbar">
												<span>{index + 1}</span>
												<select
													aria-label={t("消息 {0} 发送方", index + 1)}
													value={message.sender}
													onChange={(event) =>
														update(sampleIndex, (current) => ({
															...current,
															rounds: current.rounds.map((item) =>
																item.round === group.round
																	? {
																			...item,
																			messages: item.messages.map((entry, position) =>
																				position === index
																					? {
																							...entry,
																							sender: event.target.value as
																								| "judge"
																								| "contestant",
																						}
																					: entry,
																			),
																		}
																	: item,
															),
														}))
													}
												>
													<option value="judge">{t("裁判发送")}</option>
													<option value="contestant">{t("选手发送")}</option>
												</select>
												<button
													type="button"
													className="button secondary small"
													aria-label={t("上移消息 {0}", index + 1)}
													disabled={index === 0}
													onClick={() => move(-1)}
												>
													↑
												</button>
												<button
													type="button"
													className="button secondary small"
													aria-label={t("下移消息 {0}", index + 1)}
													disabled={index === group.messages.length - 1}
													onClick={() => move(1)}
												>
													↓
												</button>
												<button
													type="button"
													className="text-button danger"
													onClick={() =>
														update(sampleIndex, (current) => ({
															...current,
															rounds: current.rounds.map((item) =>
																item.round === group.round
																	? {
																			...item,
																			messages: item.messages.filter(
																				(_, position) => position !== index,
																			),
																		}
																	: item,
															),
														}))
													}
												>
													{t("删除")}
												</button>
											</div>
											<textarea
												id={`${prefix}-${sampleIndex}-${group.round}-${index}`}
												aria-label={t("第 {0} 轮消息 {1}", group.round, index + 1)}
												value={message.text}
												maxLength={200_000}
												spellCheck={false}
												onKeyDown={(event) => {
													if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
														event.preventDefault();
														move(event.key === "ArrowUp" ? -1 : 1);
													}
												}}
												onChange={(event) =>
													update(sampleIndex, (current) => ({
														...current,
														rounds: current.rounds.map((item) =>
															item.round === group.round
																? {
																		...item,
																		messages: item.messages.map((entry, position) =>
																			position === index
																				? { ...entry, text: event.target.value }
																				: entry,
																		),
																	}
																: item,
														),
													}))
												}
											/>
										</div>
									);
								})}
								<button
									type="button"
									className="button secondary"
									disabled={group.messages.length >= 200}
									onClick={() =>
										update(sampleIndex, (current) => ({
											...current,
											rounds: current.rounds.map((item) =>
												item.round === group.round
													? {
															...item,
															messages: [
																...item.messages,
																{ id: createClientId(), sender: "judge", text: "" },
															],
														}
													: item,
											),
										}))
									}
								>
									{t("添加消息")}
								</button>
							</fieldset>
						))}
				</section>
			))}
			<button
				type="button"
				className="button secondary"
				disabled={disabled || samples.length >= 20}
				onClick={() =>
					onChange([
						...samples,
						{
							id: createClientId(),
							rounds: [
								{ round: 1, messages: [] },
								{ round: 2, messages: [] },
							],
						},
					])
				}
			>
				{t("添加协议样例")}
			</button>
		</div>
	);
}
