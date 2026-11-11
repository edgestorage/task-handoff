export function remoteDesktopTextToSend(previous: string, current: string): string | undefined {
  if (!current) return undefined;
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length) || undefined;
  if (previous.startsWith(current)) return undefined;
  return current;
}

export type RemoteDesktopTextInputUpdate = {
  nextText: string;
  textToSend?: string;
};

/**
 * Native text input changes include IME marked text while the user is choosing
 * candidates. Keep the last committed baseline until composition ends so pinyin,
 * kana, or Hangul intermediate text never reaches the remote host.
 */
export function remoteDesktopTextInputUpdate(previousText: string, text: string, composing: boolean): RemoteDesktopTextInputUpdate {
  if (composing) return { nextText: previousText };
  return { nextText: text, textToSend: remoteDesktopTextToSend(previousText, text) };
}
