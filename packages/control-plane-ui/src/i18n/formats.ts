export const datetimeFormats = {
  "en-US": {
    time: { hour: "numeric", minute: "2-digit", second: "2-digit" },
    shortDate: { year: "numeric", month: "short", day: "numeric" },
    dateTime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  },
  "zh-CN": {
    time: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
    shortDate: { year: "numeric", month: "short", day: "numeric" },
    dateTime: { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  },
} as const;

export const numberFormats = {
  "en-US": {
    decimal: { maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
  "zh-CN": {
    decimal: { maximumFractionDigits: 2 },
    percent: { style: "percent", maximumFractionDigits: 1 },
  },
} as const;
