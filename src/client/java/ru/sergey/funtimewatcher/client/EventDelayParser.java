package ru.sergey.funtimewatcher.client;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class EventDelayParser {
	private static final Pattern CLOCK_PATTERN = Pattern.compile("\\b(?:(\\d+):)?(\\d{1,2}):(\\d{2})\\b");
	private static final Pattern DURATION_PATTERN = Pattern.compile(
		"(\\d+)\\s*(дн(?:я|ей)?|день|час(?:а|ов)?|ч|min|мин(?:ут[аы]?)?|м(?!s)|сек(?:унд[аы]?)?|с)\\b",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern NEXT_EVENT_PATTERN = Pattern.compile(
		"^\\[\\d+]\\s+До\\s+следующего\\s+ивента:\\s+(.+)$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern NAMED_EVENT_PATTERN = Pattern.compile(
		"^\\[(\\d+)]\\s+(.+?):\\s*$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern STATUS_PATTERN = Pattern.compile(
		"^\\|\\|\\s*Статус:\\s*[»>]?\\s*(.+)$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern COORDS_PATTERN = Pattern.compile(
		"^\\|\\|\\s*Координаты:\\s*(\\[[^]]+])$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern NOT_ACTIVE_PATTERN = Pattern.compile(
		"^Еще\\s+не\\s+активирован,\\s*до\\s+активации\\s+(.+)$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern STARTS_IN_PATTERN = Pattern.compile(
		"^Начн[её]тс[яь]\\s+через\\s+(.+)$",
		Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
	);
	private static final Pattern TIMER_IN_BRACKETS_PATTERN = Pattern.compile("^(.+?)\\s*\\((.+)\\)$");
	private static final Pattern TIMER_AT_END_PATTERN = Pattern.compile("^(.+?)\\s+(\\d+\\s+.+)$");

	public ParsedEventResult parse(List<String> rawLines, String anarchyCommand) {
		List<String> lines = uniqueNonEmpty(rawLines);
		String joined = String.join(" | ", lines);
		String nextEventTimerText = null;
		List<EventInfo> events = new ArrayList<>();
		EventInfo currentEvent = null;

		for (String line : lines) {
			Matcher nextEventMatcher = NEXT_EVENT_PATTERN.matcher(line);
			if (nextEventMatcher.find()) {
				nextEventTimerText = sanitize(nextEventMatcher.group(1));
				currentEvent = null;
				continue;
			}

			Matcher namedEventMatcher = NAMED_EVENT_PATTERN.matcher(line);
			if (namedEventMatcher.find()) {
				currentEvent = new EventInfo(namedEventMatcher.group(2).trim());
				events.add(currentEvent);
				continue;
			}

			Matcher statusMatcher = STATUS_PATTERN.matcher(line);
			if (statusMatcher.find()) {
				String statusText = sanitize(statusMatcher.group(1));
				if (currentEvent == null || currentEvent.hasStatus()) {
					currentEvent = EventInfo.fromStatusOnly(statusText);
					events.add(currentEvent);
				} else {
					currentEvent.setStatus(statusText);
				}
				continue;
			}

			Matcher coordsMatcher = COORDS_PATTERN.matcher(line);
			if (coordsMatcher.find() && currentEvent != null) {
				currentEvent.setCoordinates(coordsMatcher.group(1).trim());
			}
		}

		List<String> summaries = new ArrayList<>();
		List<Long> timers = new ArrayList<>();

		if (nextEventTimerText != null) {
			summaries.add("до следующего ивента " + nextEventTimerText);
			Long timer = parseDurationMillis(nextEventTimerText);
			if (timer != null && timer > 0) {
				timers.add(timer);
			}
		}

		for (EventInfo event : events) {
			String summary = event.toSummary();
			if (!summary.isBlank()) {
				summaries.add(summary);
			}

			Long timer = event.timerMs();
			if (timer != null && timer > 0) {
				timers.add(timer);
			}
		}

		Long timerMs = timers.stream().min(Long::compareTo).orElse(null);
		String messageText;
		if (!summaries.isEmpty()) {
			messageText = anarchyCommand + " " + String.join(" | ", summaries);
		} else {
			messageText = anarchyCommand + " не удалось распарсить /event delay: " + (joined.isBlank() ? "пустой ответ" : joined);
		}

		return new ParsedEventResult(anarchyCommand, lines, nextEventTimerText, events, timerMs, messageText);
	}

	public boolean looksLikeEventReply(String message) {
		String lower = sanitize(message).toLowerCase(Locale.ROOT);
		return lower.contains("ивент")
			|| lower.contains("статус")
			|| lower.contains("координаты")
			|| lower.contains("до следующего")
			|| lower.contains("до активации")
			|| lower.contains("начнётся через")
			|| lower.contains("лутание")
			|| lower.contains("призыв")
			|| lower.contains("air drop")
			|| lower.contains("алтарь")
			|| lower.contains("извержение")
			|| lower.contains("вулкан")
			|| lower.contains("маяк");
	}

	public static String sanitize(String value) {
		return String.valueOf(value)
			.replaceAll("§[0-9A-FK-ORa-fk-or]", "")
			.replaceAll("\\s+", " ")
			.trim();
	}

	private static List<String> uniqueNonEmpty(List<String> rawLines) {
		LinkedHashSet<String> values = new LinkedHashSet<>();
		for (String rawLine : rawLines) {
			String line = sanitize(rawLine);
			if (!line.isBlank()) {
				values.add(line);
			}
		}

		return new ArrayList<>(values);
	}

	private static Long parseDurationMillis(String text) {
		Matcher clockMatcher = CLOCK_PATTERN.matcher(text);
		if (clockMatcher.find()) {
			long hours = clockMatcher.group(1) == null ? 0L : Long.parseLong(clockMatcher.group(1));
			long minutes = Long.parseLong(clockMatcher.group(2));
			long seconds = Long.parseLong(clockMatcher.group(3));
			return ((hours * 3600L) + (minutes * 60L) + seconds) * 1000L;
		}

		Matcher durationMatcher = DURATION_PATTERN.matcher(text.toLowerCase(Locale.ROOT));
		long totalMs = 0L;
		boolean matched = false;
		while (durationMatcher.find()) {
			matched = true;
			long amount = Long.parseLong(durationMatcher.group(1));
			String unit = durationMatcher.group(2).toLowerCase(Locale.ROOT);
			if (unit.startsWith("д")) {
				totalMs += amount * 24L * 60L * 60L * 1000L;
			} else if (unit.startsWith("ч")) {
				totalMs += amount * 60L * 60L * 1000L;
			} else if (unit.startsWith("м")) {
				totalMs += amount * 60L * 1000L;
			} else {
				totalMs += amount * 1000L;
			}
		}

		return matched ? totalMs : null;
	}

	public record ParsedEventResult(
		String anarchyCommand,
		List<String> rawLines,
		String nextEventTimerText,
		List<EventInfo> events,
		Long timerMs,
		String messageText
	) {
		public ParsedEventResult {
			events = List.copyOf(events);
		}
	}

	public static final class EventInfo {
		private final String eventName;
		private String statusText = "";
		private String coordinates = "";

		private EventInfo(String eventName) {
			this.eventName = eventName == null ? "" : eventName.trim();
		}

		public static EventInfo fromStatusOnly(String statusText) {
			EventInfo eventInfo = new EventInfo(extractInlineName(statusText));
			eventInfo.setStatus(statusText);
			return eventInfo;
		}

		public boolean hasStatus() {
			return !statusText.isBlank();
		}

		public void setStatus(String statusText) {
			this.statusText = statusText == null ? "" : statusText.trim();
		}

		public void setCoordinates(String coordinates) {
			this.coordinates = coordinates == null ? "" : coordinates.trim();
		}

		public Long timerMs() {
			String timerText = extractTimerText();
			return timerText == null ? null : parseDurationMillis(timerText);
		}

		public String toSummary() {
			if (eventName.isBlank() && statusText.isBlank()) {
				return "";
			}

			String coordsSuffix = coordinates.isBlank() ? "" : " @ " + coordinates;
			Matcher notActiveMatcher = NOT_ACTIVE_PATTERN.matcher(statusText);
			if (notActiveMatcher.find()) {
				String timer = sanitize(notActiveMatcher.group(1));
				return "ожидается " + displayName() + "; до активации " + timer + coordsSuffix;
			}

			Matcher startsInMatcher = STARTS_IN_PATTERN.matcher(statusText);
			if (startsInMatcher.find()) {
				String timer = sanitize(startsInMatcher.group(1));
				return "ожидается " + displayName() + "; начнётся через " + timer + coordsSuffix;
			}

			Matcher bracketsMatcher = TIMER_IN_BRACKETS_PATTERN.matcher(statusText);
			if (bracketsMatcher.find()) {
				String phaseName = normalizeEventDisplayName(sanitize(bracketsMatcher.group(1)));
				String timer = sanitize(bracketsMatcher.group(2));
				if (eventName.isBlank() || phaseName.equalsIgnoreCase(displayName())) {
					return "в процессе " + displayName() + "; осталось " + timer + coordsSuffix;
				}

				return "в процессе " + displayName() + "; " + phaseName + " " + timer + coordsSuffix;
			}

			Matcher trailingTimerMatcher = TIMER_AT_END_PATTERN.matcher(statusText);
			if (trailingTimerMatcher.find()) {
				String phaseName = normalizeEventDisplayName(sanitize(trailingTimerMatcher.group(1)));
				String timer = sanitize(trailingTimerMatcher.group(2));
				if (parseDurationMillis(timer) != null) {
					if (eventName.isBlank() || phaseName.equalsIgnoreCase(displayName())) {
						return "в процессе " + displayName() + "; осталось " + timer + coordsSuffix;
					}

					return "в процессе " + displayName() + "; " + phaseName + " " + timer + coordsSuffix;
				}
			}

			if (!statusText.isBlank()) {
				if (eventName.isBlank()) {
					return statusText + coordsSuffix;
				}

				return "сейчас " + displayName() + "; " + statusText + coordsSuffix;
			}

			return displayName() + coordsSuffix;
		}

		private String displayName() {
			return eventName.isBlank() ? "Ивент" : normalizeEventDisplayName(eventName);
		}

		private String extractTimerText() {
			Matcher notActiveMatcher = NOT_ACTIVE_PATTERN.matcher(statusText);
			if (notActiveMatcher.find()) {
				return sanitize(notActiveMatcher.group(1));
			}

			Matcher startsInMatcher = STARTS_IN_PATTERN.matcher(statusText);
			if (startsInMatcher.find()) {
				return sanitize(startsInMatcher.group(1));
			}

			Matcher bracketsMatcher = TIMER_IN_BRACKETS_PATTERN.matcher(statusText);
			if (bracketsMatcher.find()) {
				return sanitize(bracketsMatcher.group(2));
			}

			Matcher trailingTimerMatcher = TIMER_AT_END_PATTERN.matcher(statusText);
			if (trailingTimerMatcher.find()) {
				String timer = sanitize(trailingTimerMatcher.group(2));
				return parseDurationMillis(timer) == null ? null : timer;
			}

			return null;
		}

		private static String extractInlineName(String statusText) {
			Matcher notActiveMatcher = NOT_ACTIVE_PATTERN.matcher(statusText);
			if (notActiveMatcher.find()) {
				return "Ивент";
			}

			Matcher startsInMatcher = STARTS_IN_PATTERN.matcher(statusText);
			if (startsInMatcher.find()) {
				return "Ивент";
			}

			Matcher bracketsMatcher = TIMER_IN_BRACKETS_PATTERN.matcher(statusText);
			if (bracketsMatcher.find()) {
				return sanitize(bracketsMatcher.group(1));
			}

			Matcher trailingTimerMatcher = TIMER_AT_END_PATTERN.matcher(statusText);
			if (trailingTimerMatcher.find()) {
				String phaseName = sanitize(trailingTimerMatcher.group(1));
				String timer = sanitize(trailingTimerMatcher.group(2));
				return parseDurationMillis(timer) == null ? "Ивент" : phaseName;
			}

			return "Ивент";
		}

		private static String normalizeEventDisplayName(String rawName) {
			if (rawName == null) {
				return "";
			}

			String normalized = rawName.trim();
			return normalized.equalsIgnoreCase("Извержение") ? "Вулкан" : normalized;
		}
	}
}
