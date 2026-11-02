use base64::Engine;
use controlled_instance_core::{atomic::write_atomic, paths::StoragePaths};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthSource {
    Env,
    File,
    Generated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebAuthState {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AuthSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_file: Option<PathBuf>,
    #[serde(skip)]
    pub token: Option<String>,
}

impl WebAuthState {
    pub fn disabled(token_file: Option<PathBuf>) -> Self {
        Self {
            enabled: false,
            source: None,
            token_file,
            token: None,
        }
    }

    pub fn status(&self) -> AuthStatus {
        AuthStatus {
            enabled: self.enabled,
            source: self.source,
            token_file: self.token_file.clone(),
        }
    }

    pub fn accepts(&self, candidate: Option<&str>) -> bool {
        if !self.enabled {
            return true;
        }
        let (Some(expected), Some(candidate)) = (self.token.as_deref(), candidate) else {
            return false;
        };
        expected.as_bytes().ct_eq(candidate.as_bytes()).into()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AuthSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_file: Option<PathBuf>,
}

pub fn resolve_web_auth(paths: &StoragePaths) -> std::io::Result<WebAuthState> {
    if std::env::var("TASK_HANDOFF_WEB_AUTH").ok().as_deref() == Some("off") {
        return Ok(WebAuthState::disabled(None));
    }
    if let Some(token) = env_optional("TASK_HANDOFF_WEB_TOKEN") {
        return Ok(WebAuthState {
            enabled: true,
            source: Some(AuthSource::Env),
            token_file: None,
            token: Some(token),
        });
    }
    if let Ok(token) = std::fs::read_to_string(&paths.web_token_path) {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Ok(WebAuthState {
                enabled: true,
                source: Some(AuthSource::File),
                token_file: Some(paths.web_token_path.clone()),
                token: Some(token),
            });
        }
    }
    if std::env::var("TASK_HANDOFF_WEB_AUTH").ok().as_deref() == Some("required") {
        let token = generate_token();
        write_atomic(
            &paths.web_token_path,
            format!("{token}\n").as_bytes(),
            Some(0o600),
        )?;
        return Ok(WebAuthState {
            enabled: true,
            source: Some(AuthSource::Generated),
            token_file: Some(paths.web_token_path.clone()),
            token: Some(token),
        });
    }
    Ok(WebAuthState::disabled(Some(paths.web_token_path.clone())))
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_is_exact_and_disabled_auth_is_open() {
        let state = WebAuthState {
            enabled: true,
            source: Some(AuthSource::Env),
            token_file: None,
            token: Some("secret".to_string()),
        };
        assert!(state.accepts(Some("secret")));
        assert!(!state.accepts(Some("Secret")));
        assert!(!state.accepts(None));
        assert!(WebAuthState::disabled(None).accepts(None));
    }

    #[test]
    fn generated_tokens_are_url_safe_and_non_empty() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(!token.contains('='));
    }
}
