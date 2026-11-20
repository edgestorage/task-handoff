import { fireEvent, render } from '@testing-library/react-native';

import { formatSessionGoalDuration, SessionGoalBar } from '../src/ai-sessions/SessionGoalBar';
import { translate } from '../src/i18n';

jest.mock('../src/i18n', () => {
  const actual = jest.requireActual('../src/i18n');
  return {
    ...actual,
    useI18n: () => ({
      locale: 'en-US',
      preference: 'en-US',
      setPreference: async () => undefined,
      t: (key: Parameters<typeof actual.translate>[1], params?: Parameters<typeof actual.translate>[2]) => actual.translate('en-US', key, params),
    }),
  };
});

const goal = {
  objective: 'Ship the mobile goal controls with authoritative updates',
  status: 'active' as const,
  tokenBudget: 10_000,
  tokensUsed: 1_234,
  timeUsedSeconds: 3_723,
};

test('active goals show budget usage and dispatch pause and clear commands', async () => {
  const onCommand = jest.fn();
  const screen = await render(<SessionGoalBar goal={goal} onCommand={onCommand} />);

  expect(screen.getByText('Goal')).toBeTruthy();
  expect(screen.getByText('Active')).toBeTruthy();
  expect(screen.getByText('1,234 / 10,000 tokens · 1h 2m 3s')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Pause goal' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Clear goal' }));
  expect(onCommand.mock.calls).toEqual([['pause'], ['clear']]);
});

test('non-active goals resume and goals without a budget show tokens only', async () => {
  const onCommand = jest.fn();
  const screen = await render(<SessionGoalBar goal={{ ...goal, status: 'paused', tokenBudget: null, tokensUsed: 42, timeUsedSeconds: 0 }} onCommand={onCommand} />);

  expect(screen.getByText('Paused')).toBeTruthy();
  expect(screen.getByText('42 tokens')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Resume goal' }));
  expect(onCommand).toHaveBeenCalledWith('resume');
});

test('the objective expands in place and disabled goals reject commands', async () => {
  const onCommand = jest.fn();
  const screen = await render(<SessionGoalBar disabled goal={goal} onCommand={onCommand} />);
  const objective = screen.getByTestId('session-goal-objective');

  expect(objective.props.accessibilityState).toEqual({ expanded: false });
  expect(screen.getByText(goal.objective).props.numberOfLines).toBe(1);
  await fireEvent.press(objective);
  expect(screen.getByTestId('session-goal-objective').props.accessibilityState).toEqual({ expanded: true });
  expect(screen.getByText(goal.objective).props.numberOfLines).toBeUndefined();

  await fireEvent.press(screen.getByRole('button', { name: 'Pause goal' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Clear goal' }));
  expect(screen.getByRole('button', { name: 'Pause goal' }).props.accessibilityState).toEqual({ disabled: true });
  expect(onCommand).not.toHaveBeenCalled();
});

test('duration formatting omits zero units', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en-US', key, params);
  expect(formatSessionGoalDuration(0, t)).toBe('');
  expect(formatSessionGoalDuration(61, t)).toBe('1m 1s');
  expect(formatSessionGoalDuration(7_200, t)).toBe('2h');
});
