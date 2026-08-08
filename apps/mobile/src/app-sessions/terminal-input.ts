const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

export class AppSessionTerminalInputNormalizer {
  private pasteBuffer: string | undefined;

  push(input: string): string {
    let pending = input;
    let output = '';
    while (pending) {
      if (this.pasteBuffer === undefined) {
        const start = pending.indexOf(BRACKETED_PASTE_START);
        if (start === -1) return output + normalizeLineEndings(pending);
        output += normalizeLineEndings(pending.slice(0, start));
        this.pasteBuffer = '';
        pending = pending.slice(start + BRACKETED_PASTE_START.length);
        continue;
      }

      const end = pending.indexOf(BRACKETED_PASTE_END);
      if (end === -1) {
        this.pasteBuffer += pending;
        return output;
      }
      const content = this.pasteBuffer + pending.slice(0, end);
      output += content === '\n' || content === '\r\n'
        ? '\r'
        : `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
      this.pasteBuffer = undefined;
      pending = pending.slice(end + BRACKETED_PASTE_END.length);
    }
    return output;
  }
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r?\n/g, '\r');
}
