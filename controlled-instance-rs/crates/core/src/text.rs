/// Count string length in the UTF-16 code units used by JavaScript and the
/// controlled-instance wire schemas.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// JavaScript String(value) coercion for JSON values. Array nulls become empty
/// elements; objects use their default string representation rather than JSON.
pub fn js_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let number = value.as_f64().unwrap_or_default();
            if number == 0.0 {
                "0".to_string()
            } else {
                number.to_string()
            }
        }
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
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
