const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../modules/task-handoff-browser');
const fixture = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'shared/browser-tunnel-fixtures.json'), 'utf8'));
const swift = fs.readFileSync(path.join(moduleRoot, 'ios/BrowserTunnelProtocol.swift'), 'utf8');
const kotlin = fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/expo/modules/taskhandoffbrowser/BrowserTunnelProtocol.kt'), 'utf8');

test('Swift and Kotlin Browser Tunnel constants consume the TypeScript fixture values', () => {
  expect(swift).toContain(`static let version = "${fixture.protocolVersion}"`);
  expect(swift).toContain(`static let headerBytes = ${fixture.limits.frameHeaderBytes}`);
  expect(swift).toContain('static let maxDataBytes = 64 * 1024');
  expect(kotlin).toContain(`const val VERSION = "${fixture.protocolVersion}"`);
  expect(kotlin).toContain(`const val HEADER_BYTES = ${fixture.limits.frameHeaderBytes}`);
  for (const [name, value] of Object.entries(fixture.frameTypes)) {
    const nativeName = name.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter}`).toUpperCase();
    expect(kotlin).toContain(`${nativeName}(${value})`);
  }
});

test('native diagnostics expose counts without credential or browsing content fields', () => {
  const diagnosticSources = [
    fs.readFileSync(path.join(moduleRoot, 'ios/MobileBrowserContextManager.swift'), 'utf8'),
    fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/expo/modules/taskhandoffbrowser/MobileBrowserContextManager.kt'), 'utf8'),
  ];
  for (const source of diagnosticSources) {
    const body = source.slice(source.indexOf('diagnostics()'));
    expect(body).toMatch(/activeContexts/);
    expect(body).not.toMatch(/"(?:token|url|cookie|filename)"/i);
  }
});
