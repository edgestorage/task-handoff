type InputSegment = {
  key: number;
  before: string;
  cursor: string;
  after: string;
  placeholder: boolean;
};

export function stripAnsi(value: unknown) {
  return String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function clampCursor(value: string, cursor: number) {
  return Math.max(0, Math.min(value.length, cursor));
}

function charColumns(char: string) {
  if (!char) {
    return 1;
  }
  const codePoint = char.codePointAt(0) || 0;
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function pushInputSegment(
  segments: InputSegment[],
  line: string,
  lineStart: number,
  start: number,
  end: number,
  cursor: number,
  placeholder: boolean,
) {
  if (start === end && cursor !== lineStart + start) {
    return;
  }

  const includesCursor = !placeholder && cursor >= lineStart + start && cursor <= lineStart + end;
  if (!includesCursor) {
    segments.push({ key: segments.length, before: line.slice(start, end), cursor: "", after: "", placeholder });
    return;
  }

  const localCursor = cursor - lineStart;
  const cursorChar = line[localCursor] || " ";
  segments.push({
    key: segments.length,
    before: line.slice(start, localCursor),
    cursor: cursorChar,
    after: line.slice(localCursor + (line[localCursor] ? 1 : 0), end),
    placeholder,
  });
}

export function renderInputLines(value: string, cursor: number, placeholder: string, columns: number) {
  const text = value || placeholder;
  const effectiveCursor = value ? clampCursor(value, cursor) : 0;
  const wrapColumns = Math.max(12, columns);
  const lines = text.split("\n");
  let offset = 0;
  const segments: InputSegment[] = [];

  lines.forEach((line) => {
    const lineStart = offset;
    const placeholderLine = !value;
    let segmentStart = 0;
    let usedColumns = 0;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const width = charColumns(char);
      if (usedColumns > 0 && usedColumns + width > wrapColumns) {
        pushInputSegment(segments, line, lineStart, segmentStart, index, effectiveCursor, placeholderLine);
        segmentStart = index;
        usedColumns = 0;
      }
      usedColumns += width;
    }

    pushInputSegment(segments, line, lineStart, segmentStart, line.length, effectiveCursor, placeholderLine);
    offset = lineStart + line.length + 1;
  });

  return segments;
}

export function moveCursorLine(value: string, cursor: number, direction: number) {
  const lines = value.split("\n");
  let offset = 0;
  let currentLine = 0;
  let column = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineLength = lines[index].length;
    if (cursor <= offset + lineLength) {
      currentLine = index;
      column = cursor - offset;
      break;
    }
    offset += lineLength + 1;
  }

  const nextLine = currentLine + direction;
  if (nextLine < 0 || nextLine >= lines.length) {
    return cursor;
  }

  const nextLineStart = lines.slice(0, nextLine).reduce((total, line) => total + line.length + 1, 0);
  return nextLineStart + Math.min(column, lines[nextLine].length);
}
