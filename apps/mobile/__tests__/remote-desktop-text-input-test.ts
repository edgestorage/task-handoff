import { remoteDesktopTextToSend } from '../src/remote-desktop/text-input';

test('sends only the new suffix when an Android IME reports cumulative text', () => {
  expect(remoteDesktopTextToSend('', 'e')).toBe('e');
  expect(remoteDesktopTextToSend('e', 'ec')).toBe('c');
  expect(remoteDesktopTextToSend('ec', 'echo')).toBe('ho');
});

test('resets on an empty controlled input and accepts replacement composition', () => {
  expect(remoteDesktopTextToSend('echo', '')).toBeUndefined();
  expect(remoteDesktopTextToSend('', 'echo MOBILE_OK')).toBe('echo MOBILE_OK');
  expect(remoteDesktopTextToSend('echo', '你好')).toBe('你好');
});

test('does not replay deletions already handled by key events', () => {
  expect(remoteDesktopTextToSend('echo', 'ech')).toBeUndefined();
});
