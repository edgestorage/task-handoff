/**
 * Minimal ANSI screen model used to turn a raw terminal stream into the last
 * visible frame. Provisioning progress (docker pull, git clone) is written with
 * carriage returns and erase sequences, so the projector must replay them
 * instead of parsing the raw chunk text.
 */
export class AnsiTerminalScreen {
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;
  private pending = "";

  write(chunk: string) {
    const input = `${this.pending}${chunk}`;
    this.pending = "";
    for (let index = 0; index < input.length;) {
      const char = input[index];
      if (char === "\u001b" && input[index + 1] === "[") {
        let end = index + 2;
        while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end += 1;
        if (end >= input.length) {
          this.pending = input.slice(index);
          break;
        }
        this.csi(input.slice(index + 2, end), input[end]);
        index = end + 1;
        continue;
      }
      if (char === "\r") this.col = 0;
      else if (char === "\n") { this.row += 1; this.col = 0; this.ensureLine(); }
      else if (char === "\b") this.col = Math.max(0, this.col - 1);
      else if (char >= " ") {
        this.ensureLine();
        this.lines[this.row][this.col] = char;
        this.col += 1;
      }
      index += 1;
    }
    this.trim();
  }

  text() {
    return this.lines.map((line) => line.join("").trimEnd()).join("\n");
  }

  private csi(raw: string, command: string) {
    const params = raw.replace(/^\?/, "").split(";").map((value) => Number(value || 1));
    const amount = params[0] || 1;
    if (command === "A") this.row = Math.max(0, this.row - amount);
    else if (command === "B") { this.row += amount; this.ensureLine(); }
    else if (command === "C") this.col += amount;
    else if (command === "D") this.col = Math.max(0, this.col - amount);
    else if (command === "G") this.col = Math.max(0, amount - 1);
    else if (command === "H" || command === "f") {
      this.row = Math.max(0, amount - 1);
      this.col = Math.max(0, (params[1] || 1) - 1);
      this.ensureLine();
    } else if (command === "K") {
      this.ensureLine();
      if ((params[0] || 0) === 2) this.lines[this.row] = [];
      else this.lines[this.row].splice(this.col);
    } else if (command === "J" && (params[0] || 0) === 2) {
      this.lines = [[]]; this.row = 0; this.col = 0;
    }
  }

  private ensureLine() {
    while (this.lines.length <= this.row) this.lines.push([]);
  }

  private trim() {
    if (this.lines.length <= 500) return;
    const remove = this.lines.length - 500;
    this.lines.splice(0, remove);
    this.row = Math.max(0, this.row - remove);
  }
}
