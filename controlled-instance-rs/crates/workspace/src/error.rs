use crate::ResolvedRepository;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct RepositoryOperationError {
    pub code: String,
    pub message: String,
    pub current: Option<Box<ResolvedRepository>>,
    pub details: Option<BTreeMap<String, serde_json::Value>>,
}

impl RepositoryOperationError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current: None,
            details: None,
        }
    }

    pub fn with_current(
        code: impl Into<String>,
        message: impl Into<String>,
        current: &ResolvedRepository,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current: Some(Box::new(current.clone())),
            details: None,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.code.as_str(),
            "REPOSITORY_STATE_STALE" | "REPOSITORY_COMMAND_TIMEOUT"
        )
    }
}
