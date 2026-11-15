import { remoteDesktopTextEdit, remoteDesktopTextInputUpdate } from '../src/remote-desktop/text-input';

test('inserts only the new suffix when an Android IME reports cumulative text', () => {
  expect(remoteDesktopTextEdit('', 'e')).toEqual({ deleteCount: 0, insertText: 'e' });
  expect(remoteDesktopTextEdit('e', 'ec')).toEqual({ deleteCount: 0, insertText: 'c' });
  expect(remoteDesktopTextEdit('ec', 'echo')).toEqual({ deleteCount: 0, insertText: 'ho' });
});

test('turns dictation corrections into a suffix deletion followed by replacement text', () => {
  expect(remoteDesktopTextEdit('今天天汽', '今天天气')).toEqual({ deleteCount: 1, insertText: '气' });
  expect(remoteDesktopTextEdit('我想去北京玩', '我想去上海玩')).toEqual({ deleteCount: 3, insertText: '上海玩' });
  expect(remoteDesktopTextEdit('你好世界', '你好')).toEqual({ deleteCount: 2, insertText: '' });
  expect(remoteDesktopTextEdit('', 'echo MOBILE_OK')).toEqual({ deleteCount: 0, insertText: 'echo MOBILE_OK' });
});

test('counts user-perceived characters when correcting emoji and combined text', () => {
  expect(remoteDesktopTextEdit('hi😀', 'hi😎')).toEqual({ deleteCount: 1, insertText: '😎' });
  expect(remoteDesktopTextEdit('hi👨‍👩‍👧‍👦', 'hi👨‍👩‍👧‍👦!')).toEqual({ deleteCount: 0, insertText: '!' });
  expect(remoteDesktopTextEdit('e\u0301', 'é')).toEqual({ deleteCount: 1, insertText: 'é' });
});

test('holds pinyin marked text until the input method commits a candidate', () => {
  let baseline = '';
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    const update = remoteDesktopTextInputUpdate(baseline, text, true);
    expect(update).toEqual({ nextText: baseline });
  }

  const committed = remoteDesktopTextInputUpdate(baseline, '你好', false);
  expect(committed).toEqual({ nextText: '你好', edit: { deleteCount: 0, insertText: '你好' } });
  baseline = committed.nextText;

  expect(remoteDesktopTextInputUpdate(baseline, '你好shi', true)).toEqual({ nextText: baseline });
  expect(remoteDesktopTextInputUpdate(baseline, '你好是', false)).toEqual({ nextText: '你好是', edit: { deleteCount: 0, insertText: '是' } });
});

test('does not send a cancelled composition or unchanged committed text', () => {
  expect(remoteDesktopTextInputUpdate('你好', '你好shi', true)).toEqual({ nextText: '你好' });
  expect(remoteDesktopTextInputUpdate('你好', '你好', false)).toEqual({ nextText: '你好', edit: undefined });
});
