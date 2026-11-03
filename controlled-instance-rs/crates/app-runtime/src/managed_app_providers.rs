use std::path::Path;

use controlled_instance_protocol::{AppCatalogItem, AppKind};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ManagedAppProviderCapabilities {
    pub supports_cwd_selection: bool,
    pub supports_ai_session_resume: bool,
    pub supports_profiles: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ManagedAppTtyRuntime {
    #[default]
    Default,
    Codex,
    OpenCode,
    Claude,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ManagedAppGuiRuntime {
    #[default]
    Default,
    Chromium,
    TerminalGui,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ManagedAppWebRuntime {
    #[default]
    Default,
    VscodeWeb,
}

pub struct ManagedAppProvider {
    pub id: &'static str,
    pub capabilities: ManagedAppProviderCapabilities,
    pub tty_runtime: ManagedAppTtyRuntime,
    pub gui_runtime: ManagedAppGuiRuntime,
    pub web_runtime: ManagedAppWebRuntime,
    ai_session_resume_args: Option<fn(&str) -> Vec<String>>,
}

impl ManagedAppProvider {
    pub fn ai_session_resume_args(&self, provider_session_id: &str) -> Option<Vec<String>> {
        self.ai_session_resume_args
            .map(|arguments| arguments(provider_session_id))
    }

    pub fn matches_runtime(&self, app: &AppCatalogItem) -> bool {
        self.gui_runtime == ManagedAppGuiRuntime::TerminalGui
            && app.kind == AppKind::Gui
            && Path::new(app.command.as_deref().unwrap_or_default())
                .file_name()
                .and_then(|name| name.to_str())
                == Some("xterm")
    }
}

fn codex_resume_args(provider_session_id: &str) -> Vec<String> {
    vec!["resume".to_string(), provider_session_id.to_string()]
}

fn claude_resume_args(provider_session_id: &str) -> Vec<String> {
    vec!["--resume".to_string(), provider_session_id.to_string()]
}

fn opencode_resume_args(provider_session_id: &str) -> Vec<String> {
    vec!["--session".to_string(), provider_session_id.to_string()]
}

const NO_CAPABILITIES: ManagedAppProviderCapabilities = ManagedAppProviderCapabilities {
    supports_cwd_selection: false,
    supports_ai_session_resume: false,
    supports_profiles: false,
};

const PROVIDERS: &[ManagedAppProvider] = &[
    ManagedAppProvider {
        id: "terminal-tty",
        capabilities: ManagedAppProviderCapabilities {
            supports_cwd_selection: true,
            supports_ai_session_resume: false,
            supports_profiles: false,
        },
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: None,
    },
    ManagedAppProvider {
        id: "codex",
        capabilities: ManagedAppProviderCapabilities {
            supports_cwd_selection: true,
            supports_ai_session_resume: true,
            supports_profiles: false,
        },
        tty_runtime: ManagedAppTtyRuntime::Codex,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: Some(codex_resume_args),
    },
    ManagedAppProvider {
        id: "opencode",
        capabilities: ManagedAppProviderCapabilities {
            supports_cwd_selection: true,
            supports_ai_session_resume: true,
            supports_profiles: false,
        },
        tty_runtime: ManagedAppTtyRuntime::OpenCode,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: Some(opencode_resume_args),
    },
    ManagedAppProvider {
        id: "claude",
        capabilities: ManagedAppProviderCapabilities {
            supports_cwd_selection: true,
            supports_ai_session_resume: true,
            supports_profiles: false,
        },
        tty_runtime: ManagedAppTtyRuntime::Claude,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: Some(claude_resume_args),
    },
    ManagedAppProvider {
        id: "terminal-gui",
        capabilities: NO_CAPABILITIES,
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::TerminalGui,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: None,
    },
    ManagedAppProvider {
        id: "chromium",
        capabilities: ManagedAppProviderCapabilities {
            supports_cwd_selection: false,
            supports_ai_session_resume: false,
            supports_profiles: true,
        },
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::Chromium,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: None,
    },
    ManagedAppProvider {
        id: "vscode-web",
        capabilities: NO_CAPABILITIES,
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::VscodeWeb,
        ai_session_resume_args: None,
    },
    ManagedAppProvider {
        id: "cc-switch",
        capabilities: NO_CAPABILITIES,
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: None,
    },
    ManagedAppProvider {
        id: "thctl",
        capabilities: NO_CAPABILITIES,
        tty_runtime: ManagedAppTtyRuntime::Default,
        gui_runtime: ManagedAppGuiRuntime::Default,
        web_runtime: ManagedAppWebRuntime::Default,
        ai_session_resume_args: None,
    },
];

pub fn managed_app_provider(app_id: &str) -> Option<&'static ManagedAppProvider> {
    PROVIDERS.iter().find(|provider| provider.id == app_id)
}

pub fn managed_app_runtime_provider(app: &AppCatalogItem) -> Option<&'static ManagedAppProvider> {
    managed_app_provider(&app.id).or_else(|| {
        PROVIDERS
            .iter()
            .find(|provider| provider.matches_runtime(app))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_own_ai_session_resume_arguments() {
        let codex = managed_app_provider("codex").expect("codex provider");
        let claude = managed_app_provider("claude").expect("claude provider");
        let opencode = managed_app_provider("opencode").expect("opencode provider");
        let terminal = managed_app_provider("terminal-tty").expect("terminal provider");

        assert_eq!(
            codex.ai_session_resume_args("codex-session"),
            Some(vec!["resume".to_string(), "codex-session".to_string()])
        );
        assert_eq!(
            claude.ai_session_resume_args("claude-session"),
            Some(vec!["--resume".to_string(), "claude-session".to_string()])
        );
        assert_eq!(
            opencode.ai_session_resume_args("opencode-session"),
            Some(vec![
                "--session".to_string(),
                "opencode-session".to_string()
            ])
        );
        assert!(!terminal.capabilities.supports_ai_session_resume);
        assert_eq!(terminal.ai_session_resume_args("terminal-session"), None);
    }

    #[test]
    fn runtime_provider_matches_node_provider_selection() {
        let xterm = AppCatalogItem {
            id: "custom-xterm".to_string(),
            name: "Custom terminal".to_string(),
            kind: AppKind::Gui,
            description: None,
            command: Some("/usr/bin/xterm".to_string()),
            args: None,
            cwd: None,
            env: None,
            display: None,
            default_display_target: None,
            automation: None,
            web: None,
        };
        assert_eq!(
            managed_app_runtime_provider(&xterm).map(|provider| provider.id),
            Some("terminal-gui")
        );
        assert_eq!(
            managed_app_provider("thctl")
                .expect("thctl provider")
                .capabilities,
            ManagedAppProviderCapabilities::default()
        );
    }
}
