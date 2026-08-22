const fs = require('node:fs');
const path = require('node:path');

const patch = fs.readFileSync(path.resolve(__dirname, '../../../patches/expo-paste-input@0.2.2.patch'), 'utf8');
const ios = fs.readFileSync(path.resolve(__dirname, '../node_modules/expo-paste-input/ios/ExpoPasteInputView.swift'), 'utf8');
const android = fs.readFileSync(path.resolve(__dirname, '../node_modules/expo-paste-input/android/src/main/java/expo/modules/pasteinput/ExpoPasteInputView.kt'), 'utf8');
const sessionComposer = fs.readFileSync(path.resolve(__dirname, '../src/ai-sessions/SessionComposer.tsx'), 'utf8');
const newSessionForm = fs.readFileSync(path.resolve(__dirname, '../src/ai-sessions/NewSessionForm.tsx'), 'utf8');

test('the versioned native patch exposes an optional atomic long-text interception API', () => {
  expect(patch).toContain('interceptTextPasteAbove?: number');
  expect(patch).toContain('intercepted?: true');
  expect(patch).toContain('text.unicodeScalars.count > interceptTextPasteAbove');
  expect(patch).toContain('text.codePointCount(0, text.length) > interceptTextPasteAbove');
});

test('iOS and Android consume long text before native insertion while retaining image priority', () => {
  expect(ios).toMatch(/if hasGIF \{[\s\S]*processPasteboardContent\(\)[\s\S]*return/);
  expect(ios).toMatch(/wrapper\.shouldInterceptTextPaste\(text\)[\s\S]*handleTextPaste\(text, intercepted: true\)[\s\S]*return/);
  expect(android).toMatch(/if \(parsed\.hasImages\)[\s\S]*return@OnReceiveContentListener null[\s\S]*shouldInterceptTextPaste\(parsed\.textContent\)/);
  expect(android).toMatch(/shouldInterceptTextPaste\(text\)[\s\S]*markSuppressOnReceiveContent\(\)[\s\S]*return true/);
});

test('short text keeps the upstream native insertion paths and does not emit intercepted', () => {
  expect(patch).toContain('// Handle short text - call original paste first, then notify');
  expect(patch).toContain('// Keep native text insertion behavior.');
  expect(patch).toContain('if (intercepted) payload["intercepted"] = true');
});

test('mobile composers intercept only normal long-text sends and preserve image priority', () => {
  expect(sessionComposer).toMatch(/props\.editingLabel \? undefined : AI_SESSION_LONG_PASTE_CODE_POINT_THRESHOLD/);
  expect(sessionComposer).toMatch(/payload\.type === 'images'[\s\S]*props\.onPasteImages/);
  expect(newSessionForm).toMatch(/payload\.type === 'images'[\s\S]*props\.onPasteImages/);
  expect(newSessionForm).toMatch(/payload\.type === 'text' && payload\.intercepted/);
});
