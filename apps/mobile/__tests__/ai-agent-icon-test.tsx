import { render } from '@testing-library/react-native';

import { AiAgentIcon, aiAgentKind } from '../src/components/AiAgentIcon';

describe('AiAgentIcon', () => {
  test.each([
    'codex',
    'claude',
    'opencode',
    'gemini',
    'commandcode',
    'dsh',
  ] as const)('renders the %s provider mark', async (agent) => {
    const screen = await render(<AiAgentIcon agent={agent} color="#fff" label={agent} />);

    expect(aiAgentKind(agent)).toBe(agent);
    expect(screen.getByTestId(`ai-agent-icon-${agent}`)).toBeTruthy();
  });

  test('does not guess a brand for unknown providers', () => {
    expect(aiAgentKind('unknown-agent')).toBeUndefined();
  });
});
