import { remoteDesktopTextInputUpdate, remoteDesktopTextToSend } from '../src/remote-desktop/text-input';

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

test('holds pinyin marked text until the input method commits a candidate', () => {
  let baseline = '';
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    const update = remoteDesktopTextInputUpdate(baseline, text, true);
    expect(update).toEqual({ nextText: baseline });
  }

  const committed = remoteDesktopTextInputUpdate(baseline, '你好', false);
  expect(committed).toEqual({ nextText: '你好', textToSend: '你好' });
  baseline = committed.nextText;

  expect(remoteDesktopTextInputUpdate(baseline, '你好shi', true)).toEqual({ nextText: baseline });
  expect(remoteDesktopTextInputUpdate(baseline, '你好是', false)).toEqual({ nextText: '你好是', textToSend: '是' });
});

test('does not send a cancelled composition or duplicate committed text', () => {
  expect(remoteDesktopTextInputUpdate('你好', '你好shi', true)).toEqual({ nextText: '你好' });
  expect(remoteDesktopTextInputUpdate('你好', '你好', false)).toEqual({ nextText: '你好', textToSend: undefined });
});
