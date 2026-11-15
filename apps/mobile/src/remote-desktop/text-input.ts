import { splitGraphemes } from '../components/graphemes';

export type RemoteDesktopTextEdit = {
  deleteCount: number;
  insertText: string;
};

/**
 * Converts the hidden input's cumulative value into the edit needed at the
 * remote end of the previously committed text. Dictation may rewrite an earlier
 * phrase, which cannot be represented by appending a suffix: remove the changed
 * suffix first, then commit the replacement. Count user-perceived characters so
 * emoji and combined Unicode are removed with one Backspace.
 */
export function remoteDesktopTextEdit(previous: string, current: string): RemoteDesktopTextEdit | undefined {
  if (previous === current) return undefined;
  const previousGraphemes = splitGraphemes(previous);
  const currentGraphemes = splitGraphemes(current);
  const limit = Math.min(previousGraphemes.length, currentGraphemes.length);
  let commonPrefix = 0;
  while (commonPrefix < limit && previousGraphemes[commonPrefix] === currentGraphemes[commonPrefix]) commonPrefix += 1;
  const deleteCount = previousGraphemes.length - commonPrefix;
  const insertText = currentGraphemes.slice(commonPrefix).join('');
  if (!deleteCount && !insertText) return undefined;
  return { deleteCount, insertText };
}

export type RemoteDesktopTextInputUpdate = {
  nextText: string;
  edit?: RemoteDesktopTextEdit;
};

/**
 * Native text input changes include IME marked text while the user is choosing
 * candidates. Keep the last committed baseline until composition ends so pinyin,
 * kana, or Hangul intermediate text never reaches the remote host.
 */
export function remoteDesktopTextInputUpdate(previousText: string, text: string, composing: boolean): RemoteDesktopTextInputUpdate {
  if (composing) return { nextText: previousText };
  return { nextText: text, edit: remoteDesktopTextEdit(previousText, text) };
}
