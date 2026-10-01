/** score(...) overrides must be complete tokens separated by ASCII whitespace in every runtime. */
export function checkerScore(code: number | null, message: string, adapted = false): number | undefined {
	if (adapted) {
		if (code !== 42 && code !== 43) return undefined;
		const partial = /^partially correct \(([0-9]+)\)(?:[ \t\r\n\f\v]|$)/u.exec(message);
		for (const original of [0, 1, 2, 7, ...(partial ? [Number(partial[1])] : [])]) {
			const score = checkerScore(original, message);
			if (score !== undefined) return code === (score === 100 ? 42 : 43) ? score : undefined;
		}
		return undefined;
	}
	let score: number;
	let wrong = false;
	if (code === 0 && /^ok(?:[ \t\r\n\f\v]|$)/u.test(message)) score = 100;
	else if ((code === 1 || code === 2) && /^(?:wrong answer|wrong output format)(?:[ \t\r\n\f\v]|$)/u.test(message)) {
		score = 0;
		wrong = true;
	} else {
		const points = /^points ([0-9]+(?:\.[0-9]+)?)(?:[ \t\r\n\f\v]|$)/u.exec(message);
		const partial = /^partially correct \(([0-9]+)\)(?:[ \t\r\n\f\v]|$)/u.exec(message);
		if (!(points && code === 7) && !(partial && code === Number(partial[1]))) return undefined;
		const value = Number((points ?? partial)?.[1]);
		const ratio = value > 1 ? value / 100 : value;
		if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return undefined;
		score = ratio === 1 ? 100 : Math.min(99, Math.floor(ratio * 100));
	}
	const explicit = /(?:^|[ \t\r\n\f\v])score\((-?[0-9]+)\)(?=$|[ \t\r\n\f\v])/u.exec(message);
	if (explicit) score = Number(explicit[1]);
	if (!Number.isSafeInteger(score) || score < 0 || score > 100 || (wrong && score === 100)) return undefined;
	return score;
}

export const pythonCheckerProtocol = String.raw`
def normalized_checker_score(code, message):
    wrong = False
    if code == 0 and re.match(r'^ok(?:[ \t\r\n\f\v]|$)', message): score = 100
    elif code in (1, 2) and re.match(r'^(wrong answer|wrong output format)(?:[ \t\r\n\f\v]|$)', message):
        score = 0
        wrong = True
    else:
        points = re.match(r'^points ([0-9]+(?:\.[0-9]+)?)(?:[ \t\r\n\f\v]|$)', message)
        partial = re.match(r'^partially correct \(([0-9]+)\)(?:[ \t\r\n\f\v]|$)', message)
        if not ((points and code == 7) or (partial and code == int(partial.group(1)))): return None
        value = float((points or partial).group(1))
        ratio = value / 100 if value > 1 else value
        if not math.isfinite(ratio) or not 0 <= ratio <= 1: return None
        score = 100 if ratio == 1 else min(99, math.floor(ratio * 100))
    explicit = re.search(r'(?:^|[ \t\r\n\f\v])score\((-?[0-9]+)\)(?=$|[ \t\r\n\f\v])', message)
    if explicit: score = int(explicit.group(1))
    if not 0 <= score <= 100 or (wrong and score == 100): return None
    return score
`;

export const awkCheckerProtocol = String.raw`LC_ALL=C awk -v status="$status" '
NR == 1 {
    if (status == 0 && /^ok([[:space:]]|$)/) { valid = 1; score = 100 }
    else if ((status == 1 || status == 2) && /^(wrong answer|wrong output format)([[:space:]]|$)/) { valid = 1; wrong = 1; score = 0 }
    else if (status == 7 && /^points [0-9]+([.][0-9]+)?([[:space:]]|$)/) { valid = 1; value = $2; ratio = value > 1 ? value / 100 : value; score = ratio == 1 ? 100 : int(ratio * 100); if (ratio < 0 || ratio > 1) valid = 0; if (ratio < 1 && score >= 100) score = 99 }
    else if (/^partially correct \([0-9]+\)([[:space:]]|$)/) {
        value = $3; gsub(/[()]/, "", value)
        if (status == value) { valid = 1; ratio = value > 1 ? value / 100 : value; score = ratio == 1 ? 100 : int(ratio * 100); if (ratio < 0 || ratio > 1) valid = 0 }
    }
}
match($0, /(^|[[:space:]])score\(-?[0-9]+\)([[:space:]]|$)/) {
    if (!explicit) {
        token = substr($0, RSTART, RLENGTH)
        sub(/^[[:space:]]*score\(/, "", token)
        sub(/\)[[:space:]]*$/, "", token)
        score = token + 0; explicit = 1
    }
}
END { if (!valid || score < 0 || score > 100 || (wrong && score == 100)) exit 1; if (score == 100) exit 42; exit 43 }
' "$3/judgemessage.txt"`;
