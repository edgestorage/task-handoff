mod agent_run_bindings;
mod ai_session_authority;
mod ai_session_coordination;
mod ai_session_delta_coalescer;
mod ai_session_hierarchy;
mod ai_session_open_app;
mod ai_session_validation;
mod app_session_authority;
pub mod auth;
mod browser_tunnel;
mod claude_discovery;
mod codex_discovery;
pub mod config;
mod diagnostics;
pub mod events;
pub mod git_credentials;
pub mod git_provisioning;
mod instance_shell;
pub mod node_agent_client;
mod private_model;
pub mod server;
mod session_titles;
pub mod state;
mod story_agent_tool_bridge;
mod story_tools;

// Compatibility for v0.0.46: Node's ws transport accepts up to 100 MiB.
// Subprotocol decoders own their smaller frame limits and structured errors.
pub(crate) const WEBSOCKET_MAX_PAYLOAD_BYTES: usize = 100 * 1024 * 1024;

pub use agent_run_bindings::{
    AgentRunMemberBinding, AgentRunMemberBindingInput, AgentRunMemberBindingStore,
};
pub use config::{
    resolve_package_version, ControlMode, InstanceConfig, RuntimeKind, ServerOptions,
};
pub use git_credentials::{
    install_git_broker_environment, run_git_credential_helper, run_git_ssh, run_git_ssh_askpass,
    GitCredentialBroker, GitCredentialBrokerOptions,
};
pub use git_provisioning::{
    run_provisioning_git_credential_helper, run_provisioning_git_ssh,
    select_provisioning_credential, GitProvisioningError,
};
pub use instance_shell::InstanceShellRuntime;
pub use node_agent_client::{NodeAgentClient, NodeAgentClientConfig, NodeAgentClientError};
pub use private_model::{
    ControlledModelConfig, ManagedModelConfigApplyResult, ManagedModelEnvironmentApplyResult,
    ManagedModelError,
};
pub use server::run_web;
pub use state::AppState;
