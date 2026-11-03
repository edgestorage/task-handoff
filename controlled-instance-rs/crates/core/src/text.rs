/// Count string length in the UTF-16 code units used by JavaScript and the
/// controlled-instance wire schemas.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Compare strings using JavaScript's default `Array.prototype.sort()` order,
/// which compares UTF-16 code units rather than Unicode scalar values.
pub fn cmp_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Match JavaScript `value.slice(0, max)` at a valid UTF-8 boundary.
pub fn truncate_utf16(value: &str, max: usize) -> String {
    let mut output = String::new();
    let mut units = 0;
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        output.push(character);
        units += width;
    }
    output
}

/// Match JavaScript `value.slice(-max)` at a valid UTF-8 boundary.
pub fn truncate_utf16_tail(value: &str, max: usize) -> String {
    let mut characters = Vec::new();
    let mut units = 0;
    for character in value.chars().rev() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        characters.push(character);
        units += width;
    }
    characters.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_uses_utf16_code_units() {
        assert_eq!(utf16_len("😀😀😀"), 6);
        assert_eq!(truncate_utf16("😀😀😀", 5), "😀😀");
        assert_eq!(truncate_utf16("abcdef", 3), "abc");
        assert_eq!(truncate_utf16_tail("abcdef", 3), "def");
        assert_eq!(truncate_utf16_tail("😀😀😀", 5), "😀😀");
    }

    #[test]
    fn ordering_uses_utf16_code_units() {
        let mut names = vec!["\u{e000}.txt", "😀.txt", "z.txt", "a.txt"];
        names.sort_by(|left, right| cmp_utf16(left, right));
        assert_eq!(names, vec!["a.txt", "z.txt", "😀.txt", "\u{e000}.txt"]);
    }
}
