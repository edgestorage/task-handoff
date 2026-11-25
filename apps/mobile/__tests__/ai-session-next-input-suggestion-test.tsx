import fs from 'node:fs';
import path from 'node:path';

import { fireEvent, render } from '@testing-library/react-native';

import { SessionNextInputSuggestionCard } from '../src/ai-sessions/SessionNextInputSuggestionCard';
import {
  consumeNextInputSuggestion,
  nextInputSuggestionForSession,
  nextInputSuggestionKey,
  resetNextInputSuggestionConsumption,
  visibleNextInputSuggestion,
} from '../src/ai-sessions/next-input-suggestion';
import { MobileThemeProvider } from '../src/components/theme';
import { MobileI18nProvider } from '../src/i18n';

const suggestion = {
  text: '继续修复测试。',
  turnId: 'turn_1',
  generatedAt: '2026-11-25T00:00:31.000Z',
};

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ses_0000000000001',
    status: 'idle',
    queue: { pendingCount: 0 },
    nextInputSuggestion: suggestion,
    ...overrides,
  } as never;
}

function visible(overrides: Partial<Parameters<typeof visibleNextInputSuggestion>[0]> = {}) {
  return visibleNextInputSuggestion({
    controlPlaneId: 'cp_1',
    instanceId: 'ins_1',
    sessionId: 'ses_0000000000001',
    suggestion,
    draft: '',
    attachmentCount: 0,
    editing: false,
    actionsEnabled: true,
    ...overrides,
  });
}

beforeEach(() => resetNextInputSuggestionConsumption());

test('mobile suggestions only follow the current settled turn', () => {
  expect(nextInputSuggestionForSession(session(), 'turn_1')).toEqual(suggestion);
  expect(nextInputSuggestionForSession(undefined, 'turn_1')).toBeUndefined();
  expect(nextInputSuggestionForSession(session({ status: 'running' }), 'turn_1')).toBeUndefined();
  expect(nextInputSuggestionForSession(session({ queue: { pendingCount: 1 } }), 'turn_1')).toBeUndefined();
  expect(nextInputSuggestionForSession(session({ lineage: { kind: 'subagent' } }), 'turn_1')).toBeUndefined();
  expect(nextInputSuggestionForSession(session(), 'turn_2')).toBeUndefined();
});

test('mobile visibility respects draft, attachments, editing, sync and consumption', () => {
  expect(visible()).toEqual(suggestion);
  expect(visible({ draft: 'typed' })).toBeUndefined();
  expect(visible({ attachmentCount: 1 })).toBeUndefined();
  expect(visible({ editing: true })).toBeUndefined();
  expect(visible({ actionsEnabled: false })).toBeUndefined();

  consumeNextInputSuggestion(nextInputSuggestionKey('cp_1', 'ins_1', 'ses_0000000000001', 'turn_1'));
  expect(visible()).toBeUndefined();
  expect(visible({ draft: 'typed' })).toBeUndefined();
});

test('mobile consumption stays bounded for long-running clients', () => {
  consumeNextInputSuggestion('cp_1:ins_1:ses_0000000000001:turn_1');
  expect(visible()).toBeUndefined();
  for (let index = 0; index < 2_500; index += 1) consumeNextInputSuggestion(`cp:ins:ses:turn_${index}`);
  expect(visible()).toEqual(suggestion);
});

test('the suggestion card fills or dismisses without sending', async () => {
  const onUse = jest.fn();
  const onDismiss = jest.fn();
  const view = await render(
    <MobileThemeProvider>
      <MobileI18nProvider>
        <SessionNextInputSuggestionCard onDismiss={onDismiss} onUse={onUse} text={suggestion.text} />
      </MobileI18nProvider>
    </MobileThemeProvider>,
  );
  expect(view.getByText(suggestion.text)).toBeTruthy();
  await fireEvent.press(view.getByLabelText(`Use suggested next message: ${suggestion.text}`));
  expect(onUse).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('Dismiss suggestion'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('workspace wiring accepts into the draft, focuses, and keeps the card above the composer', () => {
  const workspace = fs.readFileSync(path.join(__dirname, '../src/ai-sessions/SessionWorkspace.tsx'), 'utf8');
  const accept = workspace.indexOf('const acceptNextInputSuggestion = () => {');
  const block = workspace.slice(accept, workspace.indexOf('const dismissNextInputSuggestion', accept));
  expect(block).toContain('setDraft(text);');
  expect(block).toContain('void drafts.write(controlPlaneId, instanceId, session.id, text);');
  expect(block).toContain('setComposerSelectionEnd(text.length);');
  expect(block).not.toMatch(/performAction|actions\.(send|message)|runComposerAction/);

  const actions = workspace.indexOf('testID="session-actions"');
  const card = workspace.indexOf('<SessionNextInputSuggestionCard');
  const composer = workspace.indexOf('<SessionComposer');
  expect(actions).toBeGreaterThan(-1);
  expect(card).toBeGreaterThan(actions);
  expect(composer).toBeGreaterThan(card);
});

test('mobile transports subscribe to the suggestion projection', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['src/control-plane/direct-transport.ts', 'src/control-plane/relay-transport.ts']) {
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain('nextInputSuggestion: true');
  }
  for (const key of ['suggestion.label', 'suggestion.use', 'suggestion.useHint', 'suggestion.dismiss']) {
    expect(fs.readFileSync(path.join(root, 'src/i18n/messages.ts'), 'utf8')).toContain(`'${key}'`);
  }
});
