const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
];

export function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function timezoneOffsetLabel(timezone: string, date = new Date()) {
  try {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;

    return offset?.replace(/^GMT/, "UTC");
  } catch {
    return undefined;
  }
}

export function timezoneOptions(...preferredTimezones: Array<string | undefined>) {
  const supportedValuesOf = (Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  }).supportedValuesOf;
  const supportedTimezones = supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_TIMEZONES;

  return Array.from(new Set([
    ...preferredTimezones.filter((timezone): timezone is string => Boolean(timezone)),
    currentTimezone(),
    "UTC",
    ...supportedTimezones,
  ]));
}
