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
