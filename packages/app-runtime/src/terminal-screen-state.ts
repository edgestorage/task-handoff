import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

type SynchronousHeadlessTerminal = Terminal & {
  _core?: { writeSync?: (data: string) => void };
};

type EscapeState = "text" | "escape" | "csi" | "string" | "string-escape";

const ESC = "\x1b";
const BEL = "\x07";
const CANCEL = "\x18";
const SUBSTITUTE = "\x1a";
const MAX_PENDING_ESCAPE_LENGTH = 4096;

class PendingEscapeSequence {
  private value = "";

  push(chunk: string) {
    const input = `${this.value}${chunk}`;
    let state: EscapeState = "text";
    let sequenceStart = -1;
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (state === "text") {
        if (character === ESC) {
          state = "escape";
          sequenceStart = index;
        }
        continue;
      }
      if (character === CANCEL || character === SUBSTITUTE) {
        state = "text";
        sequenceStart = -1;
        continue;
      }
      if (state === "escape") {
        if (character === "[") state = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) state = "string";
        else if (character === ESC) sequenceStart = index;
        else if (character.charCodeAt(0) >= 0x30) {
          state = "text";
          sequenceStart = -1;
        }
        continue;
      }
      if (state === "csi") {
        if (character === ESC) {
          state = "escape";
          sequenceStart = index;
        } else {
          const code = character.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            state = "text";
            sequenceStart = -1;
          }
        }
        continue;
      }
      if (state === "string") {
        if (character === BEL) {
          state = "text";
          sequenceStart = -1;
        } else if (character === ESC) {
          state = "string-escape";
        }
        continue;
      }
      if (character === "\\") {
        state = "text";
        sequenceStart = -1;
      } else if (character !== ESC) {
        state = "string";
      }
    }
    const pending = sequenceStart >= 0 ? input.slice(sequenceStart) : "";
    this.value = pending.length <= MAX_PENDING_ESCAPE_LENGTH ? pending : "";
  }

  get current() {
    return this.value;
  }
}

export type TerminalScreenSnapshot = {
  data: string;
  pendingEscape: string;
};

export class TerminalScreenState {
  private readonly terminal: SynchronousHeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private readonly pendingEscape = new PendingEscapeSequence();
  private readonly scrollback: number;

  constructor(cols: number, rows: number, scrollback = 1000) {
    this.scrollback = scrollback;
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true, logLevel: "off" });
    this.terminal.loadAddon(this.serializer);
  }

  write(data: string) {
    const writeSync = this.terminal._core?.writeSync;
    if (!writeSync) {
      throw new Error("The installed @xterm/headless build does not support synchronous terminal snapshots.");
    }
    writeSync.call(this.terminal._core, data);
    this.pendingEscape.push(data);
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }

  snapshot(): TerminalScreenSnapshot {
    return {
      data: this.serializer.serialize({ scrollback: this.scrollback }),
      pendingEscape: this.pendingEscape.current,
    };
  }

  dispose() {
    this.terminal.dispose();
  }
}
