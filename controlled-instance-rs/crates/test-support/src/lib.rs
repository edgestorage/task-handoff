pub fn normalize_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            for (_, value) in object.iter_mut() {
                normalize_json(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                normalize_json(value);
            }
        }
        _ => {}
    }
}

pub fn json_equivalent(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    left == right
}
