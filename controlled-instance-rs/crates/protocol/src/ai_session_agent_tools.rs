use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// Tool names granted to managed Story agents. The list is part of the
/// provider-facing permission contract and must match the Control Plane's
/// `AI_SESSION_AGENT_TOOL_NAMES` wire model.
pub const AI_SESSION_AGENT_TOOL_NAMES: &[&str] = &[
    "story_list_content",
    "story_get_content",
    "story_set_content",
    "story_list_actions",
    "story_run_action",
    "story_list_automations",
    "story_create_automation",
    "story_update_automation",
    "story_delete_automation",
    "story_run_automation",
    "story_list_automation_runs",
    "story_list_ai_sessions",
    "story_get_ai_session",
    "story_get_ai_session_turn",
    "story_request_decision",
    "agent_run",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiSessionAgentToolName {
    StoryListContent,
    StoryGetContent,
    StorySetContent,
    StoryListActions,
    StoryRunAction,
    StoryListAutomations,
    StoryCreateAutomation,
    StoryUpdateAutomation,
    StoryDeleteAutomation,
    StoryRunAutomation,
    StoryListAutomationRuns,
    StoryListAiSessions,
    StoryGetAiSession,
    StoryGetAiSessionTurn,
    StoryRequestDecision,
    AgentRun,
}

impl AiSessionAgentToolName {
    pub const ALL: &'static [Self] = &[
        Self::StoryListContent,
        Self::StoryGetContent,
        Self::StorySetContent,
        Self::StoryListActions,
        Self::StoryRunAction,
        Self::StoryListAutomations,
        Self::StoryCreateAutomation,
        Self::StoryUpdateAutomation,
        Self::StoryDeleteAutomation,
        Self::StoryRunAutomation,
        Self::StoryListAutomationRuns,
        Self::StoryListAiSessions,
        Self::StoryGetAiSession,
        Self::StoryGetAiSessionTurn,
        Self::StoryRequestDecision,
        Self::AgentRun,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::StoryListContent => "story_list_content",
            Self::StoryGetContent => "story_get_content",
            Self::StorySetContent => "story_set_content",
            Self::StoryListActions => "story_list_actions",
            Self::StoryRunAction => "story_run_action",
            Self::StoryListAutomations => "story_list_automations",
            Self::StoryCreateAutomation => "story_create_automation",
            Self::StoryUpdateAutomation => "story_update_automation",
            Self::StoryDeleteAutomation => "story_delete_automation",
            Self::StoryRunAutomation => "story_run_automation",
            Self::StoryListAutomationRuns => "story_list_automation_runs",
            Self::StoryListAiSessions => "story_list_ai_sessions",
            Self::StoryGetAiSession => "story_get_ai_session",
            Self::StoryGetAiSessionTurn => "story_get_ai_session_turn",
            Self::StoryRequestDecision => "story_request_decision",
            Self::AgentRun => "agent_run",
        }
    }
}

impl std::fmt::Display for AiSessionAgentToolName {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AiSessionAgentToolName {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .iter()
            .copied()
            .find(|tool| tool.as_str() == value)
            .ok_or_else(|| format!("Unknown AI Session agent tool name: {value}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn agent_tool_names_are_unique_and_stable() {
        let names = AI_SESSION_AGENT_TOOL_NAMES
            .iter()
            .copied()
            .collect::<HashSet<_>>();
        assert_eq!(names.len(), AI_SESSION_AGENT_TOOL_NAMES.len());
        assert!(names.contains("story_request_decision"));
        assert!(names.contains("agent_run"));
    }

    #[test]
    fn typed_agent_tool_names_round_trip_the_wire_contract() {
        let names = AiSessionAgentToolName::ALL
            .iter()
            .map(|tool| tool.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, AI_SESSION_AGENT_TOOL_NAMES);
        for tool in AiSessionAgentToolName::ALL {
            assert_eq!(tool.as_str().parse::<AiSessionAgentToolName>(), Ok(*tool));
        }
    }
}
