type Translate = (key: string, values?: Record<string, unknown>) => string;

export function storyAutomationDayOfMonthLabel(dayOfMonth: number, t: Translate) {
  if (dayOfMonth === -1) return t("stories.automation.lastDay");
  if (dayOfMonth === -2) return t("stories.automation.secondLastDay");
  if (dayOfMonth === -3) return t("stories.automation.thirdLastDay");
  return t("stories.automation.dayOrdinal", { day: dayOfMonth });
}
