use serde::{
    de::{Error, Visitor},
    Deserializer,
};
use std::fmt;

struct IntegralVisitor;

impl<'de> Visitor<'de> for IntegralVisitor {
    type Value = u128;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a non-negative integral JSON number")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(value as u128)
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: Error,
    {
        u128::try_from(value).map_err(|_| E::custom("expected a non-negative integer"))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: Error,
    {
        if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
            return Err(E::custom("expected a non-negative integral number"));
        }
        Ok(value as u128)
    }
}

fn deserialize_integral<'de, D>(deserializer: D) -> Result<u128, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(IntegralVisitor)
}

pub fn deserialize_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = deserialize_integral(deserializer)?;
    u32::try_from(value).map_err(|_| D::Error::custom("integer is outside the u32 range"))
}

pub fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = deserialize_integral(deserializer)?;
    u64::try_from(value).map_err(|_| D::Error::custom("integer is outside the u64 range"))
}

pub fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_u64(deserializer).map(Some)
}
