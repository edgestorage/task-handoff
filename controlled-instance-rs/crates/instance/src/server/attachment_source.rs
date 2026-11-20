use axum::body::Bytes;
use controlled_instance_core::text::js_string;
use futures_util::{stream, StreamExt};
use serde_json::Value;

use super::{js_truthy, parse_js_number};

#[derive(Clone, Copy)]
pub(super) enum Contract {
    Pipeline,
    Append,
}

pub(super) struct SourceError {
    pub code: &'static str,
    pub message: String,
}

pub(super) type SourceStream = stream::BoxStream<'static, Result<Bytes, SourceError>>;

/// Compatibility for v0.0.47: Fastify passes parsed JSON as the source. Node's
/// pipeline validates stream chunks, while append explicitly calls Buffer.from.
/// Keep conversion lazy so an invalid later chunk does not undo earlier writes.
pub(super) fn from_json(
    value: Value,
    contract: Contract,
    declared_size: u64,
) -> Result<SourceStream, SourceError> {
    let values = match value {
        Value::String(value) => vec![Value::String(value)],
        Value::Array(values) => values,
        value => {
            return Err(match contract {
                Contract::Pipeline => invalid_arg(
                    "The \"body\" argument must be of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair.",
                    &value,
                ),
                Contract::Append => SourceError {
                    code: "AI_SESSION_CONTROL_FAILED",
                    message: if value.is_null() {
                        "Cannot read properties of null (reading 'Symbol(Symbol.asyncIterator)')"
                    } else {
                        "body is not async iterable"
                    }.to_string(),
                },
            });
        }
    };
    Ok(stream::iter(values)
        .map(move |value| match contract {
            Contract::Pipeline => match value {
                Value::String(value) => Ok(Bytes::from(value)),
                Value::Null => Err(SourceError {
                    code: "ERR_STREAM_NULL_VALUES",
                    message: "May not write null values to stream".to_string(),
                }),
                value => Err(invalid_arg(
                    "The \"chunk\" argument must be of type string or an instance of Buffer, TypedArray, or DataView.",
                    &value,
                )),
            },
            Contract::Append => buffer_from_json(value, declared_size),
        })
        .boxed())
}

fn invalid_arg(prefix: &str, value: &Value) -> SourceError {
    let received = match value {
        Value::Null => "null".to_string(),
        Value::Object(_) => "an instance of Object".to_string(),
        Value::Array(_) => "an instance of Array".to_string(),
        Value::Bool(value) => format!("type boolean ({value})"),
        Value::Number(_) => format!("type number ({})", js_string(value)),
        Value::String(value) => format!("type string ({value:?})"),
    };
    SourceError {
        code: "ERR_INVALID_ARG_TYPE",
        message: format!("{prefix} Received {received}"),
    }
}

fn buffer_from_json(value: Value, declared_size: u64) -> Result<Bytes, SourceError> {
    // JSON has no typed arrays or callable coercion hooks. Handle its array,
    // Buffer.toJSON and array-like representations at this private boundary.
    // Materialize at most one byte beyond the declared bound; the upload owner
    // then reports the size mismatch without allocating an unbounded length.
    let limit = declared_size.saturating_add(1) as usize;
    let values = match value {
        Value::String(value) => return Ok(Bytes::from(value)),
        Value::Array(values) => values,
        Value::Object(ref object) => {
            if object.get("valueOf").is_some_and(js_truthy) {
                return Err(SourceError {
                    code: "AI_SESSION_CONTROL_FAILED",
                    message: "value.valueOf is not a function".to_string(),
                });
            }
            if let Some(length) = object.get("length") {
                let length = length.as_f64().unwrap_or_default().max(0.0) as usize;
                return Ok((0..length.min(limit))
                    .map(|index| buffer_byte(object.get(&index.to_string())))
                    .collect::<Vec<_>>()
                    .into());
            }
            if object.get("type").and_then(Value::as_str) == Some("Buffer") {
                if let Some(Value::Array(values)) = object.get("data") {
                    return Ok(values
                        .iter()
                        .take(limit)
                        .map(|value| buffer_byte(Some(value)))
                        .collect::<Vec<_>>()
                        .into());
                }
            }
            return Err(invalid_arg("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.", &value));
        }
        value => return Err(invalid_arg("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.", &value)),
    };
    Ok(values
        .iter()
        .take(limit)
        .map(|value| buffer_byte(Some(value)))
        .collect::<Vec<_>>()
        .into())
}

fn buffer_byte(value: Option<&Value>) -> u8 {
    let number = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => u8::from(*value) as f64,
        Some(Value::Number(value)) => value.as_f64().unwrap_or_default(),
        Some(value) => parse_js_number(&js_string(value)).unwrap_or_default(),
    };
    if number.is_finite() {
        number.trunc().rem_euclid(256.0) as u8
    } else {
        0
    }
}
