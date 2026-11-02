use avt::{Color, Pen, Terminal};
use serde::Serialize;

const SCROLLBACK_ROWS: usize = 1000;
const MAX_PENDING_ESCAPE_LENGTH: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreenSnapshot {
    pub data: String,
    pub pending_escape: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct TerminalScreenState {
    terminal: Terminal,
    pending_escape: PendingEscapeSequence,
    cols: u16,
    rows: u16,
}

impl TerminalScreenState {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Self {
            terminal: Terminal::with_scrollback(
                usize::from(cols),
                usize::from(rows),
                Some(SCROLLBACK_ROWS),
            )
            .expect("terminal dimensions are non-zero"),
            pending_escape: PendingEscapeSequence::default(),
            cols,
            rows,
        }
    }

    pub fn write(&mut self, data: &str) {
        self.terminal.feed(data);
        self.pending_escape.push(data);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.terminal.resize(usize::from(cols), usize::from(rows));
        self.cols = cols;
        self.rows = rows;
    }

    pub fn snapshot(&self) -> TerminalScreenSnapshot {
        let screen = self.terminal.screen();
        let mut data = String::new();
        for line in screen.all_lines() {
            let cells = line.cells();
            let end = cells
                .iter()
                .rposition(|cell| cell.char() != ' ' || !cell.pen().is_default())
                .map(|index| index + 1)
                .unwrap_or(0);
            let mut pen = Pen::default();
            for cell in &cells[..end] {
                if cell.width() == 0 {
                    continue;
                }
                if cell.pen() != &pen {
                    pen = *cell.pen();
                    data.push_str(&sgr(pen));
                }
                data.push(cell.char());
            }
            if !line.is_wrapped() {
                data.push_str("\r\n");
            }
        }
        data.push_str("\x1b[0m");
        let cursor = self.terminal.cursor();
        if let Some((col, row)) = cursor.position() {
            data.push_str("\x1b[?25h");
            data.push_str(&format!("\x1b[{};{}H", row + 1, col + 1));
        } else {
            data.push_str("\x1b[?25l");
        }
        TerminalScreenSnapshot {
            data,
            pending_escape: self.pending_escape.current().to_string(),
            cols: self.cols,
            rows: self.rows,
        }
    }
}

fn sgr(pen: Pen) -> String {
    let mut params = vec!["0".to_string()];
    if pen.is_bold() {
        params.push("1".to_string());
    }
    if pen.is_faint() {
        params.push("2".to_string());
    }
    if pen.is_italic() {
        params.push("3".to_string());
    }
    if pen.is_underline() {
        params.push("4".to_string());
    }
    if pen.is_blink() {
        params.push("5".to_string());
    }
    if pen.is_inverse() {
        params.push("7".to_string());
    }
    if pen.is_strikethrough() {
        params.push("9".to_string());
    }
    if let Some(color) = pen.foreground() {
        append_color(&mut params, color, false);
    }
    if let Some(color) = pen.background() {
        append_color(&mut params, color, true);
    }
    format!("\x1b[{}m", params.join(";"))
}

fn append_color(params: &mut Vec<String>, color: Color, background: bool) {
    match color {
        Color::Indexed(index @ 0..=7) => {
            params.push(format!("{}{}", if background { 40 } else { 30 }, index))
        }
        Color::Indexed(index @ 8..=15) => params.push(format!(
            "{}{}",
            if background { 100 } else { 90 },
            index - 8
        )),
        Color::Indexed(index) => {
            params.push(format!("{};5;{index}", if background { 48 } else { 38 }))
        }
        Color::RGB(rgb) => params.push(format!(
            "{};2;{};{};{}",
            if background { 48 } else { 38 },
            rgb.r,
            rgb.g,
            rgb.b
        )),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Csi,
    String,
    StringEscape,
}

#[derive(Debug, Default)]
struct PendingEscapeSequence {
    value: String,
}

impl PendingEscapeSequence {
    fn push(&mut self, chunk: &str) {
        let input = format!("{}{}", self.value, chunk);
        let mut state = EscapeState::Text;
        let mut sequence_start = None;
        for (index, character) in input.char_indices() {
            match state {
                EscapeState::Text => {
                    if character == '\u{1b}' {
                        state = EscapeState::Escape;
                        sequence_start = Some(index);
                    }
                }
                EscapeState::Escape => match character {
                    '\u{18}' | '\u{1a}' => {
                        state = EscapeState::Text;
                        sequence_start = None;
                    }
                    '[' => state = EscapeState::Csi,
                    ']' | 'P' | 'X' | '^' | '_' => state = EscapeState::String,
                    '\u{1b}' => sequence_start = Some(index),
                    character if character >= '0' => {
                        state = EscapeState::Text;
                        sequence_start = None;
                    }
                    _ => {}
                },
                EscapeState::Csi => {
                    if character == '\u{1b}' {
                        state = EscapeState::Escape;
                        sequence_start = Some(index);
                    } else if ('@'..='~').contains(&character) {
                        state = EscapeState::Text;
                        sequence_start = None;
                    }
                }
                EscapeState::String => {
                    if character == '\u{7}' {
                        state = EscapeState::Text;
                        sequence_start = None;
                    } else if character == '\u{1b}' {
                        state = EscapeState::StringEscape;
                    }
                }
                EscapeState::StringEscape => {
                    if character == '\\' {
                        state = EscapeState::Text;
                        sequence_start = None;
                    } else if character != '\u{1b}' {
                        state = EscapeState::String;
                    }
                }
            }
        }
        self.value = sequence_start
            .map(|start| input[start..].to_string())
            .filter(|value| value.len() <= MAX_PENDING_ESCAPE_LENGTH)
            .unwrap_or_default();
    }

    fn current(&self) -> &str {
        &self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_restore_scrollback_styles_and_cursor() {
        let mut screen = TerminalScreenState::new(20, 4);
        screen.write("\x1b[31mred\x1b[0m\r\nsecond\r\nthird\r\nfourth\r\nfifth");
        let snapshot = screen.snapshot();
        assert!(snapshot.data.contains("red"));
        assert!(snapshot.data.contains("second"));
        assert!(snapshot.data.contains("fifth"));
        assert!(snapshot.data.contains('\u{1b}'));
        assert!(snapshot.data.ends_with("\x1b[0m\x1b[?25h\x1b[4;6H"));
        assert_eq!(snapshot.pending_escape, "");
        assert_eq!((snapshot.cols, snapshot.rows), (20, 4));
    }

    #[test]
    fn incomplete_escape_sequences_are_reported_separately() {
        let mut screen = TerminalScreenState::new(20, 4);
        screen.write("hello\x1b[31");
        let snapshot = screen.snapshot();
        assert!(snapshot.data.contains("hello"));
        assert_eq!(snapshot.pending_escape, "\x1b[31");
    }

    #[test]
    fn resize_changes_snapshot_dimensions_and_reflows_output() {
        let mut screen = TerminalScreenState::new(20, 4);
        screen.write("abcdefghij");
        screen.resize(6, 3);
        let snapshot = screen.snapshot();
        assert_eq!((snapshot.cols, snapshot.rows), (6, 3));
        assert!(snapshot.data.contains("abcdef"));
        assert!(snapshot.data.contains("ghij"));
    }
}
