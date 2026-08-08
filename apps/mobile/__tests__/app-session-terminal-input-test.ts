import { AppSessionTerminalInputNormalizer } from '../src/app-sessions/terminal-input';

test('normalizes software keyboard return to the PTY enter byte', () => {
  const normalizer = new AppSessionTerminalInputNormalizer();
  expect(normalizer.push('\u001b[200~')).toBe('');
  expect(normalizer.push('\n')).toBe('');
  expect(normalizer.push('\u001b[201~')).toBe('\r');
});

test('preserves hardware keyboard enter and ordinary text', () => {
  const normalizer = new AppSessionTerminalInputNormalizer();
  expect(normalizer.push('\r')).toBe('\r');
  expect(normalizer.push('echo hello')).toBe('echo hello');
});

test('preserves bracketed paste for actual pasted content', () => {
  const normalizer = new AppSessionTerminalInputNormalizer();
  expect(normalizer.push('\u001b[200~echo one\necho two\u001b[201~')).toBe('\u001b[200~echo one\necho two\u001b[201~');
});

test('normalizes unwrapped software keyboard line endings', () => {
  const normalizer = new AppSessionTerminalInputNormalizer();
  expect(normalizer.push('echo one\necho two\n')).toBe('echo one\recho two\r');
  expect(normalizer.push('\r\n')).toBe('\r');
});
