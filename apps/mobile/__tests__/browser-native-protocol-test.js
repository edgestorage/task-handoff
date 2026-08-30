const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../modules/task-handoff-browser');
const fixture = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'shared/browser-tunnel-fixtures.json'), 'utf8'));
const swift = fs.readFileSync(path.join(moduleRoot, 'ios/BrowserTunnelProtocol.swift'), 'utf8');
const kotlin = fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/expo/modules/taskhandoffbrowser/BrowserTunnelProtocol.kt'), 'utf8');
const kotlinChannel = fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/expo/modules/taskhandoffbrowser/BrowserTunnelChannel.kt'), 'utf8');
const kotlinContext = fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/expo/modules/taskhandoffbrowser/MobileBrowserContextManager.kt'), 'utf8');
const browserRoute = fs.readFileSync(path.resolve(__dirname, '../app/browser/[instanceId]/[browserTabId].tsx'), 'utf8');
const webModule = fs.readFileSync(path.join(moduleRoot, 'src/TaskHandoffBrowserModule.web.ts'), 'utf8');
const appsRoute = fs.readFileSync(path.resolve(__dirname, '../app/(tabs)/(main)/apps/index.tsx'), 'utf8');
const browserList = fs.readFileSync(path.resolve(__dirname, '../src/browser/BrowserTabList.tsx'), 'utf8');

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

test('mobile Browser keeps one mounted native view per instance tab and suspends on route blur', () => {
  expect(browserRoute).toMatch(/instanceTabs\.map\(\(candidate\) =>[\s\S]*?<TaskHandoffBrowserView/);
  expect(browserRoute).toMatch(/key=\{candidate\.id\}/);
  expect(browserRoute).toMatch(/!active && styles\.hiddenWebViewLayer/);
  expect(browserRoute).toMatch(/router\.setParams\(\{ browserTabId: candidate\.id \}\)/);
  expect(browserRoute).not.toMatch(/router\.replace\(`/);
  expect(browserRoute).toMatch(/const requestedTab = instanceTabs\.find/);
  expect(browserRoute).toMatch(/const tab = requestedTab \|\| instanceTabs\.find\(\(candidate\) => candidate\.id === snapshot\.activeTabId\)/);
  expect(browserRoute).toMatch(/return \(\) => \{[\s\S]*?mobileBrowserController\.suspend\(tabControlPlaneId, tabInstanceId\)/);
  expect(browserRoute).toMatch(/\{contextId \? instanceTabs\.map/);
});

test('Android Browser Tunnel processes inbound binary frames through one FIFO consumer', () => {
  expect(kotlinChannel).toMatch(/inboundFrames = Channel<BrowserTunnelProtocol\.Frame>/);
  expect(kotlinChannel).toMatch(/for \(frame in inboundFrames\)[\s\S]*?handle\(frame\)/);
  expect(kotlinChannel).toMatch(/inboundFrames\.trySend\(frame\)/);
  expect(kotlinChannel).not.toMatch(/scope\.launch \{ runCatching \{ handle\(/);
});

test('native browser contexts can activate a retained instance without rebuilding its profile', () => {
  expect(kotlinContext).toMatch(/suspend fun activate\(contextId: String\)/);
  expect(kotlinContext).not.toMatch(/contextsById\.isNotEmpty\(\)[\s\S]*?Close the active instance Browser context/);
});

test('Android Browser WebView proxy forces loopback targets through the tunnel', () => {
  expect(kotlinContext).toMatch(/addProxyRule\("socks:\/\/127\.0\.0\.1:\$port"\)[\s\S]*?addBypassRule\("<-loopback>"\)/);
});

test('web Browser module keeps the native context API shape', () => {
  expect(webModule).toMatch(/activateBrowserContext\(_contextId: string\)/);
});

test('App Sessions keeps local browser tabs visible after leaving the browser route', () => {
  expect(appsRoute).toMatch(/import \{ BrowserTabList \} from .*browser\/BrowserTabList/);
  expect(appsRoute).toMatch(/function SectionTabs/);
  expect(appsRoute).toMatch(/section === 'browser'[\s\S]*?<BrowserTabList/);
  expect(appsRoute).toMatch(/section === 'browser'[\s\S]*?<BrowserTabList[\s\S]*?header=\{<SectionTabs/);
  expect(appsRoute).toMatch(/: <AppSessionList[\s\S]*?header=\{<SectionTabs/);
  expect(browserList).toMatch(/mobileBrowserTabStore\.subscribe/);
  expect(browserList).toMatch(/router\.push\(`\/browser/);
  expect(browserList).toMatch(/tab\.title/);
  expect(browserList).toMatch(/tab\.currentUrl/);
});
