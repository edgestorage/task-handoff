export function remoteDesktopTextToSend(previous: string, current: string): string | undefined {
  if (!current) return undefined;
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length) || undefined;
  if (previous.startsWith(current)) return undefined;
  return current;
}
