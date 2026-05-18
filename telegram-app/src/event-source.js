const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const CANONICAL_EVENTS = [
	"Air Drop",
	"Алтарь нежити",
	"Гейзер",
	"Вулкан",
	"Маяк убийцы",
	"Мистический сундук",
	"Сундук смерти",
	"Адская резня",
	"Метеоритный дождь"
];

const EXACT_EVENT_ALIASES = new Map([
	["air drop", "Air Drop"],
	["air-drop", "Air Drop"],
	["airdrop", "Air Drop"],
	["аир-дроп", "Air Drop"],
	["аир дроп", "Air Drop"],
	["алтарь", "Алтарь нежити"],
	["алтарь нежити", "Алтарь нежити"],
	["гейзер", "Гейзер"],
	["извержение", "Вулкан"],
	["вулкан", "Вулкан"],
	["маяк убийцы", "Маяк убийцы"],
	["маяк-убийцы", "Маяк убийцы"],
	["маяк смерти", "Маяк убийцы"],
	["мист", "Мистический сундук"],
	["мистик", "Мистический сундук"],
	["мистический сундук", "Мистический сундук"],
	["сундук смерти", "Сундук смерти"],
	["сундук убийцы", "Сундук смерти"],
	["с-с", "Сундук смерти"],
	["адская резня", "Адская резня"],
	["метеоритный дождь", "Метеоритный дождь"]
]);

const EVENT_PATTERNS = [
	{ regex: /air[\s-]?drop|аир[\s-]?дроп/i, label: "Air Drop" },
	{ regex: /алтар/i, label: "Алтарь нежити" },
	{ regex: /гейзер/i, label: "Гейзер" },
	{ regex: /призыв\s+нежити/i, label: "Алтарь нежити" },
	{ regex: /изверж|вулкан/i, label: "Вулкан" },
	{ regex: /маяк(?:-|\s)?(?:убийц|смерт)/i, label: "Маяк убийцы" },
	{ regex: /мист/i, label: "Мистический сундук" },
	{ regex: /сундук(?:\s+)?(?:смерт|убийц)|\bс-с\b/i, label: "Сундук смерти" },
	{ regex: /адск.*резн/i, label: "Адская резня" },
	{ regex: /метеорит/i, label: "Метеоритный дождь" }
];

const GENERIC_LABELS = new Set([
	"",
	"ивент",
	"событие",
	"неизвестный ивент",
	"без структуры"
]);

const STAGE_ONLY_LABELS = new Set([
	"Лутание",
	"Призыв нежити",
	"Сундук открыт"
]);

const NON_CATALOG_LABELS = new Set([
	"Следующий ивент",
	"Ивент",
	"Неизвестный ивент",
	"Без структуры",
	"Голосование",
	...STAGE_ONLY_LABELS
]);

function scoreTextReadability(text) {
	let score = 0;

	for (const char of String(text || "")) {
		if (/[А-Яа-яЁё]/.test(char)) {
			score += 3;
		} else if (/[A-Za-z0-9]/.test(char)) {
			score += 2;
		} else if (/\s/.test(char)) {
			score += 1;
		} else if (/[[\]():;,.!@#%&*+\-_=/?<>|«»]/.test(char)) {
			score += 0.5;
		} else if (/[ЃѓЉљЊњЋћЏџ�]/.test(char)) {
			score -= 4;
		} else {
			score -= 1;
		}
	}

	return score;
}

function decodeMaybeMojibake(value) {
	let text = String(value ?? "");
	if (!text) {
		return "";
	}

	for (let attempt = 0; attempt < 2; attempt += 1) {
		let candidate = text;
		try {
			candidate = iconv.decode(iconv.encode(text, "win1251"), "utf8");
		} catch {
			return text;
		}

		if (scoreTextReadability(candidate) <= scoreTextReadability(text)) {
			break;
		}

		text = candidate;
	}

	return text;
}

function getDurationPartRegex() {
	return /(\d+)\s*(дн(?:я|ей)?|день|час(?:а|ов)?|ч|min|мин(?:ут[аы]?)?|м(?!s)|сек(?:унд[аы]?)?|с)(?=$|[\s).,;:])/gi;
}

function cleanLabel(value) {
	return decodeMaybeMojibake(value)
		.replace(/[«»]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeLabel(label) {
	const clean = cleanLabel(label);
	if (!clean) {
		return "";
	}

	const exact = EXACT_EVENT_ALIASES.get(clean.toLowerCase());
	if (exact) {
		return exact;
	}

	const inferred = inferEventLabel(clean);
	return inferred || clean;
}

function inferEventLabel(text) {
	const clean = cleanLabel(text);
	if (!clean) {
		return "";
	}

	const exact = EXACT_EVENT_ALIASES.get(clean.toLowerCase());
	if (exact) {
		return exact;
	}

	for (const pattern of EVENT_PATTERNS) {
		if (pattern.regex.test(clean)) {
			return pattern.label;
		}
	}

	return "";
}

function isGenericLabel(label) {
	return GENERIC_LABELS.has(cleanLabel(label).toLowerCase());
}

function isCatalogEligible(label) {
	return Boolean(label) && !NON_CATALOG_LABELS.has(label) && !isGenericLabel(label);
}

function extractDurationText(rawText) {
	if (!rawText) {
		return "";
	}

	const text = cleanLabel(rawText);
	const clockMatch = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
	if (clockMatch) {
		return clockMatch[0];
	}

	const matches = [...text.matchAll(getDurationPartRegex())].map((match) => `${match[1]} ${match[2]}`);
	return matches.join(" ").trim();
}

function durationToMs(rawText) {
	if (!rawText) {
		return null;
	}

	const text = cleanLabel(rawText).toLowerCase();
	const clockMatch = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
	if (clockMatch) {
		const hours = Number(clockMatch[1] || 0);
		const minutes = Number(clockMatch[2] || 0);
		const seconds = Number(clockMatch[3] || 0);
		return ((hours * 60 + minutes) * 60 + seconds) * 1000;
	}

	let totalMs = 0;
	let found = false;
	for (const match of text.matchAll(getDurationPartRegex())) {
		found = true;
		const amount = Number(match[1]);
		const unit = match[2].toLowerCase();
		if (unit.startsWith("д")) {
			totalMs += amount * 24 * 60 * 60 * 1000;
		} else if (unit.startsWith("ч")) {
			totalMs += amount * 60 * 60 * 1000;
		} else if (unit.startsWith("м") || unit === "min") {
			totalMs += amount * 60 * 1000;
		} else {
			totalMs += amount * 1000;
		}
	}

	return found ? totalMs : null;
}

function createEvent(raw) {
	const rawLabel = cleanLabel(raw.label);
	const inferredLabel = inferEventLabel(raw.inferredFrom || raw.statusText || raw.description || rawLabel);
	const normalizedLabel = normalizeLabel(rawLabel);
	const label = !isGenericLabel(normalizedLabel)
		? normalizedLabel
		: inferredLabel || normalizedLabel || "Неизвестный ивент";
	const timerText = cleanLabel(raw.timerText || "");
	const sortTimerMs = Number.isFinite(raw.sortTimerMs)
		? raw.sortTimerMs
		: (Number.isFinite(raw.timerMs) ? raw.timerMs : Number.MAX_SAFE_INTEGER);

	return {
		type: raw.type || "raw",
		label,
		stage: cleanLabel(raw.stage || ""),
		statusText: cleanLabel(raw.statusText || ""),
		timerText,
		timerMs: Number.isFinite(raw.timerMs) ? raw.timerMs : durationToMs(timerText),
		sortTimerMs,
		coordinates: cleanLabel(raw.coordinates || ""),
		description: cleanLabel(raw.description || raw.statusText || raw.label || ""),
		synthetic: Boolean(raw.synthetic),
		catalogEligible: !raw.synthetic && isCatalogEligible(label)
	};
}

function parseStatusPayload(label, statusText) {
	const cleanStatus = cleanLabel(statusText);
	const durationText = extractDurationText(cleanStatus);
	const timerMs = durationToMs(cleanStatus);
	const inferredLabel = inferEventLabel(cleanStatus);
	const eventLabel = !isGenericLabel(label) ? label : inferredLabel || label;

	if (/^еще не активирован/i.test(cleanStatus)
		|| /^начн[её]т/i.test(cleanStatus)
		|| /до активации/i.test(cleanStatus)
		|| /старт через/i.test(cleanStatus)
		|| /до начала/i.test(cleanStatus)) {
		return {
			type: "scheduled",
			label: eventLabel,
			statusText: cleanStatus,
			timerText: durationText,
			timerMs
		};
	}

	if (/^лутани/i.test(cleanStatus) || /^сундук открыт/i.test(cleanStatus)) {
		return {
			type: "active",
			label: eventLabel,
			stage: "Лутание",
			timerText: durationText,
			timerMs
		};
	}

	if (/^призыв нежити/i.test(cleanStatus)) {
		return {
			type: "active",
			label: inferEventLabel(cleanStatus) || eventLabel || "Алтарь нежити",
			stage: "Призыв нежити",
			timerText: durationText,
			timerMs
		};
	}

	if (inferredLabel && inferredLabel === eventLabel && durationText) {
		return {
			type: "active",
			label: eventLabel,
			timerText: durationText,
			timerMs
		};
	}

	return {
		type: "active",
		label: eventLabel,
		statusText: cleanStatus,
		timerText: durationText,
		timerMs
	};
}

function finalizeChatEvent(currentEvent) {
	const baseLabel = normalizeLabel(currentEvent.label);
	const payload = currentEvent.statusText
		? parseStatusPayload(baseLabel, currentEvent.statusText)
		: {
			type: "active",
			label: baseLabel,
			timerText: "",
			timerMs: null
		};

	return createEvent({
		...payload,
		label: payload.label || baseLabel,
		coordinates: currentEvent.coordinates,
		description: currentEvent.statusText
			? `${currentEvent.label}: ${currentEvent.statusText}`
			: currentEvent.label,
		inferredFrom: `${currentEvent.label} ${currentEvent.statusText || ""}`
	});
}

function parseRawChatEvents(chatLines) {
	const events = [];
	let currentEvent = null;

	for (const line of chatLines) {
		const clean = cleanLabel(line);
		if (!clean || clean === "[Ивенты]") {
			continue;
		}

		const nextEventMatch = clean.match(/^\[\d+]\s+До следующего ивента:\s+(.+)$/i);
		if (nextEventMatch) {
			events.push(createEvent({
				type: "next",
				label: "Следующий ивент",
				timerText: nextEventMatch[1],
				timerMs: durationToMs(nextEventMatch[1]),
				description: clean,
				synthetic: true
			}));
			continue;
		}

		const headerMatch = clean.match(/^\[\d+]\s+(.+?):\s*$/);
		if (headerMatch) {
			if (currentEvent) {
				events.push(finalizeChatEvent(currentEvent));
			}

			currentEvent = {
				label: headerMatch[1],
				statusText: "",
				coordinates: ""
			};
			continue;
		}

		if (!currentEvent) {
			continue;
		}

		const statusMatch = clean.match(/^\|\|\s*Статус:\s*[»> ]*\s*(.+)$/i);
		if (statusMatch) {
			currentEvent.statusText = statusMatch[1];
			continue;
		}

		const coordinatesMatch = clean.match(/^\|\|\s*Координаты:\s*(\[[^\]]+])$/i);
		if (coordinatesMatch) {
			currentEvent.coordinates = coordinatesMatch[1];
		}
	}

	if (currentEvent) {
		events.push(finalizeChatEvent(currentEvent));
	}

	return events.length
		? events
		: [
			createEvent({
				type: "raw",
				label: "Без структуры",
				description: chatLines.join(" | "),
				synthetic: true
			})
		];
}

function parseSummarySegment(segment) {
	const clean = cleanLabel(segment);

	const nextEventMatch = clean.match(/^до следующего ивента (.+)$/i);
	if (nextEventMatch) {
		return createEvent({
			type: "next",
			label: "Следующий ивент",
			timerText: nextEventMatch[1],
			timerMs: durationToMs(nextEventMatch[1]),
			description: clean,
			synthetic: true
		});
	}

	const waitingMatch = clean.match(/^ожидается (.+?); (?:до активации|старт через) (.+?)(?: @ (\[[^\]]+]))?$/i);
	if (waitingMatch) {
		const rawLabel = waitingMatch[1];
		const inferred = inferEventLabel(clean);
		const normalized = normalizeLabel(rawLabel);
		const label = !isGenericLabel(normalized) ? normalized : inferred || "Ивент";
		return createEvent({
			type: isCatalogEligible(label) ? "scheduled" : "raw",
			label,
			statusText: isCatalogEligible(label) ? "" : clean,
			timerText: waitingMatch[2],
			timerMs: durationToMs(waitingMatch[2]),
			coordinates: waitingMatch[3] || "",
			description: clean,
			synthetic: !isCatalogEligible(label)
		});
	}

	const activeStageMatch = clean.match(/^в процессе (.+?); стадия (.+?); осталось (.+?)(?: @ (\[[^\]]+]))?$/i);
	if (activeStageMatch) {
		const label = normalizeLabel(activeStageMatch[1]);
		const stage = cleanLabel(activeStageMatch[2]);
		return createEvent({
			type: "active",
			label,
			stage,
			timerText: activeStageMatch[3],
			timerMs: durationToMs(activeStageMatch[3]),
			coordinates: activeStageMatch[4] || "",
			description: clean,
			synthetic: !isCatalogEligible(label)
		});
	}

	const activeMatch = clean.match(/^в процессе (.+?); осталось (.+?)(?: @ (\[[^\]]+]))?$/i);
	if (activeMatch) {
		const label = normalizeLabel(activeMatch[1]);
		return createEvent({
			type: "active",
			label,
			timerText: activeMatch[2],
			timerMs: durationToMs(activeMatch[2]),
			coordinates: activeMatch[3] || "",
			description: clean,
			synthetic: !isCatalogEligible(label)
		});
	}

	const activeStatusMatch = clean.match(/^в процессе (.+?); статус (.+?)(?: @ (\[[^\]]+]))?$/i);
	if (activeStatusMatch) {
		const rawLabel = normalizeLabel(activeStatusMatch[1]);
		const statusPayload = parseStatusPayload(rawLabel, activeStatusMatch[2]);
		return createEvent({
			...statusPayload,
			label: statusPayload.label || rawLabel,
			coordinates: activeStatusMatch[3] || "",
			description: clean,
			inferredFrom: clean,
			synthetic: !isCatalogEligible(statusPayload.label || rawLabel)
		});
	}

	return createEvent({
		type: "raw",
		label: clean,
		description: clean,
		synthetic: true
	});
}

function parseWatcherSummary(summary) {
	const segments = cleanLabel(summary).split(" | ").map((segment) => segment.trim()).filter(Boolean);
	if (!segments.length) {
		return [
			createEvent({
				type: "raw",
				label: "Без структуры",
				description: summary,
				synthetic: true
			})
		];
	}

	return segments.map(parseSummarySegment);
}

function stripLeadingAnarchy(summaryText, anarchy) {
	const cleanSummary = cleanLabel(summaryText);
	const cleanAnarchy = cleanLabel(anarchy);
	if (!cleanSummary || !cleanAnarchy) {
		return cleanSummary;
	}

	return cleanSummary.startsWith(`${cleanAnarchy} `)
		? cleanSummary.slice(cleanAnarchy.length).trim()
		: cleanSummary;
}

function extractChatText(line) {
	const match = line.match(/\(Minecraft\)\s\[System]\s\[CHAT]\s(.+)$/);
	return match ? cleanLabel(match[1]) : "";
}

function isEventChatLine(chatText) {
	return chatText === "[Ивенты]" || /^\[\d+]/.test(chatText) || /^\|\|/.test(chatText);
}

function formatUpdatedAtLabel(value, timeZone) {
	const date = value ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) {
		return "";
	}

	return new Intl.DateTimeFormat("ru-RU", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZone: timeZone || "UTC"
	}).format(date);
}

function buildSnapshotFromEntries(entries, options = {}) {
	const byAnarchy = new Map();
	let lastUpdatedAt = null;

	for (const entry of entries) {
		const anarchy = cleanLabel(entry?.anarchy);
		if (!anarchy) {
			continue;
		}

		const rawLines = Array.isArray(entry.rawLines)
			? entry.rawLines.map((line) => cleanLabel(line)).filter(Boolean)
			: [];
		const summaryText = cleanLabel(entry.summaryText || "");
		const events = rawLines.length
			? parseRawChatEvents(rawLines)
			: parseWatcherSummary(stripLeadingAnarchy(summaryText, anarchy));
		const updatedAtLabel = cleanLabel(entry.updatedAtLabel || formatUpdatedAtLabel(entry.updatedAt, options.timeZone));

		byAnarchy.set(anarchy, {
			anarchy,
			timeText: updatedAtLabel,
			summary: summaryText,
			events,
			updatedAtLabel
		});

		if (entry.updatedAt) {
			const currentDate = new Date(entry.updatedAt);
			if (!Number.isNaN(currentDate.getTime()) && (!lastUpdatedAt || currentDate > lastUpdatedAt)) {
				lastUpdatedAt = currentDate;
			}
		}
	}

	const anarchies = [...byAnarchy.values()].sort((left, right) =>
		left.anarchy.localeCompare(right.anarchy, undefined, { numeric: true })
	);

	const eventNames = [
		...new Set(
			[
				...CANONICAL_EVENTS,
				...anarchies
					.flatMap((entry) => entry.events)
					.filter((event) => event.catalogEligible)
					.map((event) => event.label)
			]
		)
	].sort((left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }));

	return {
		logPath: options.logPath || "push://event-snapshots",
		anarchies,
		lastUpdatedAt: lastUpdatedAt ? formatUpdatedAtLabel(lastUpdatedAt.toISOString(), options.timeZone) : null,
		eventNames,
		rawCount: anarchies.length
	};
}

function buildAnarchySnapshot(logPath) {
	if (!fs.existsSync(logPath)) {
		return {
			logPath,
			anarchies: [],
			lastUpdatedAt: null,
			eventNames: [],
			rawCount: 0
		};
	}

	const content = fs.readFileSync(logPath, "utf8");
	const lines = content.split(/\r?\n/);
	const byAnarchy = new Map();
	let lastUpdatedAt = null;
	let pendingChatLines = [];
	let collectingEvents = false;

	for (const line of lines) {
		const chatText = extractChatText(line);
		if (chatText) {
			if (chatText === "[Ивенты]") {
				pendingChatLines = [chatText];
				collectingEvents = true;
				continue;
			}

			if (collectingEvents) {
				if (isEventChatLine(chatText)) {
					pendingChatLines.push(chatText);
				}
				continue;
			}
		}

		const summaryMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})][^\n]*\(funtimewatcher\)\s(\/an\d+)\s(.+)$/);
		if (!summaryMatch) {
			continue;
		}

		const [, timeText, anarchy, summary] = summaryMatch;
		if (summary.startsWith("/an")) {
			continue;
		}

		const events = pendingChatLines.length > 1
			? parseRawChatEvents(pendingChatLines)
			: parseWatcherSummary(summary);

		byAnarchy.set(anarchy, {
			anarchy,
			timeText,
			summary: cleanLabel(summary),
			events,
			updatedAtLabel: timeText
		});

		lastUpdatedAt = timeText;
		pendingChatLines = [];
		collectingEvents = false;
	}

	const anarchies = [...byAnarchy.values()].sort((left, right) =>
		left.anarchy.localeCompare(right.anarchy, undefined, { numeric: true })
	);

	const eventNames = [
		...new Set(
			[
				...CANONICAL_EVENTS,
				...anarchies
					.flatMap((entry) => entry.events)
					.filter((event) => event.catalogEligible)
					.map((event) => event.label)
			]
		)
	].sort((left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }));

	return {
		logPath: path.resolve(logPath),
		anarchies,
		lastUpdatedAt,
		eventNames,
		rawCount: anarchies.length
	};
}

function buildAnarchySnapshotFromPushRows(rows, options = {}) {
	return buildSnapshotFromEntries(
		(rows || []).map((row) => ({
			anarchy: row.anarchy,
			summaryText: row.summary_text,
			rawLines: (() => {
				try {
					return JSON.parse(row.raw_lines_json || "[]");
				} catch {
					return [];
				}
			})(),
			updatedAt: row.updated_at
		})),
		{
			logPath: options.logPath || "push://event-snapshots",
			timeZone: options.timeZone || "UTC"
		}
	);
}

function flattenEvents(snapshot) {
	const rows = [];

	for (const entry of snapshot.anarchies) {
		for (const event of entry.events) {
			rows.push({
				anarchy: entry.anarchy,
				updatedAtLabel: entry.updatedAtLabel,
				summary: entry.summary,
				...event
			});
		}
	}

	return rows;
}

function getEventModeRank(event, mode) {
	if (mode === "current") {
		return event.type === "active" ? 0 : event.type === "scheduled" ? 1 : event.type === "next" ? 2 : 3;
	}

	if (mode === "upcoming") {
		return event.type === "scheduled" ? 0 : event.type === "next" ? 1 : event.type === "raw" ? 2 : 3;
	}

	return event.type === "active" ? 0 : event.type === "scheduled" ? 1 : event.type === "next" ? 2 : 3;
}

function getSortableTimerMs(event) {
	if (Number.isFinite(event.timerMs)) {
		return event.timerMs;
	}

	if (Number.isFinite(event.sortTimerMs) && event.sortTimerMs !== Number.MAX_SAFE_INTEGER) {
		return event.sortTimerMs;
	}

	return null;
}

function getUpdatedAtSortValue(event) {
	const raw = String(event.updatedAtLabel || "");
	const match = raw.match(/^(\d{2}):(\d{2}):(\d{2})$/);
	if (!match) {
		return -1;
	}

	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function getSortMode(settings) {
	if ([
		"time_asc",
		"time_desc",
		"anarchy_asc",
		"anarchy_desc"
	].includes(settings.sortMode)) {
		return settings.sortMode;
	}

	return settings.sortDirection === "desc" ? "time_desc" : "time_asc";
}

function compareAnarchy(left, right, direction = 1) {
	return left.anarchy.localeCompare(right.anarchy, undefined, { numeric: true }) * direction;
}

function filterAndSortEvents(snapshot, settings, mode) {
	const events = flattenEvents(snapshot).filter((event) => {
		if (mode === "current" && event.type !== "active") {
			return false;
		}

		if (mode === "upcoming" && event.type === "active") {
			return false;
		}

		if (settings.activeOnly && event.type !== "active" && event.type !== "scheduled") {
			return false;
		}

		if (settings.eventFilters?.length) {
			return settings.eventFilters.includes(event.label);
		}

		return true;
	});

	const sortMode = getSortMode(settings);
	const timeDirection = sortMode === "time_desc" ? -1 : 1;
	const anarchyDirection = sortMode === "anarchy_desc" ? -1 : 1;

	events.sort((left, right) => {
		if (sortMode === "anarchy_asc" || sortMode === "anarchy_desc") {
			const anarchyCompare = compareAnarchy(left, right, anarchyDirection);
			if (anarchyCompare !== 0) {
				return anarchyCompare;
			}

			const leftRank = getEventModeRank(left, mode);
			const rightRank = getEventModeRank(right, mode);
			if (leftRank !== rightRank) {
				return leftRank - rightRank;
			}

			const leftTimer = getSortableTimerMs(left);
			const rightTimer = getSortableTimerMs(right);
			const leftHasTimer = leftTimer !== null;
			const rightHasTimer = rightTimer !== null;

			if (leftHasTimer !== rightHasTimer) {
				return leftHasTimer ? -1 : 1;
			}

			if (leftHasTimer && rightHasTimer && leftTimer !== rightTimer) {
				return leftTimer - rightTimer;
			}

			const leftUpdatedAt = getUpdatedAtSortValue(left);
			const rightUpdatedAt = getUpdatedAtSortValue(right);
			if (leftUpdatedAt !== rightUpdatedAt) {
				return rightUpdatedAt - leftUpdatedAt;
			}

			return left.label.localeCompare(right.label, "ru", { sensitivity: "base" });
		}

		const leftTimer = getSortableTimerMs(left);
		const rightTimer = getSortableTimerMs(right);
		const leftHasTimer = leftTimer !== null;
		const rightHasTimer = rightTimer !== null;

		if (leftHasTimer !== rightHasTimer) {
			return leftHasTimer ? -1 : 1;
		}

		if (leftHasTimer && rightHasTimer && leftTimer !== rightTimer) {
			return (leftTimer - rightTimer) * timeDirection;
		}

		const leftRank = getEventModeRank(left, mode);
		const rightRank = getEventModeRank(right, mode);
		if (leftRank !== rightRank) {
			return leftRank - rightRank;
		}

		const leftUpdatedAt = getUpdatedAtSortValue(left);
		const rightUpdatedAt = getUpdatedAtSortValue(right);
		if (leftUpdatedAt !== rightUpdatedAt) {
			return rightUpdatedAt - leftUpdatedAt;
		}

		const labelCompare = left.label.localeCompare(right.label, "ru", { sensitivity: "base" });
		if (labelCompare !== 0) {
			return labelCompare;
		}

		return compareAnarchy(left, right, 1);
	});

	return events;
}

module.exports = {
	buildAnarchySnapshot,
	buildAnarchySnapshotFromPushRows,
	filterAndSortEvents,
	durationToMs,
	normalizeLabel
};
