export function formatSessionUpdatedTime(value: string, locale: string, yesterdayLabel: string, now = new Date()) {
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) return '';

  const time = updatedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (isSameCalendarDay(updatedAt, now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(updatedAt, yesterday)) {
    return `${yesterdayLabel} ${time}`;
  }

  const date = updatedAt.toLocaleDateString(locale, {
    ...(updatedAt.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
  });
  return `${date} ${time}`;
}

function isSameCalendarDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}
