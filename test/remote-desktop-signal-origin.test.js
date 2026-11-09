const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  fileName: filename,
}).outputText, filename);
const { isRemoteDesktopLocalNetworkAddress } = require('../packages/protocol/src/remote-desktop.ts');
const { remoteDesktopSignalOriginAllowed } = require('../packages/control-plane/src/control-plane/remote-desktop/signal-origin.ts');

const base = {
  requestProtocol: 'http',
  host: '192.168.139.109:8081',
  origin: 'http://192.168.139.109:8081',
  remoteAddress: '192.168.139.3',
  publicBaseUrl: 'http://192.168.139.109:8081',
  allowInsecurePrivateNetwork: true,
};

test('private LAN addresses are recognized without treating public or host names as local', () => {
  for (const value of ['10.0.0.1', '100.100.1.2', '169.254.1.1', '172.16.1.2', '172.31.255.254', '192.168.139.109', '::ffff:192.168.1.2', 'fc00::1', 'fd12::1', 'fe80::1%eth0']) {
    assert.equal(isRemoteDesktopLocalNetworkAddress(value), true, value);
  }
  for (const value of ['127.0.0.1', '8.8.8.8', '172.32.0.1', '192.169.0.1', 'localhost', 'example.com', '2001:db8::1']) {
    assert.equal(isRemoteDesktopLocalNetworkAddress(value), false, value);
  }
});

test('private HTTP signaling requires the deployment opt-in and an exact private origin', () => {
  assert.equal(remoteDesktopSignalOriginAllowed(base), true);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, allowInsecurePrivateNetwork: false }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, origin: 'http://192.168.139.4:8081' }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, remoteAddress: '203.0.113.5' }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, host: 'cp.example.com:8081', origin: 'http://cp.example.com:8081' }), false);
});

test('loopback and HTTPS signaling remain valid without the private HTTP opt-in', () => {
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: 'http', host: '127.0.0.1:8081', origin: 'http://127.0.0.1:8081', remoteAddress: '127.0.0.1',
    publicBaseUrl: 'http://192.168.139.109:8081', allowInsecurePrivateNetwork: false,
  }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: 'https', host: 'cp.example.com', origin: 'https://cp.example.com', remoteAddress: '203.0.113.5',
    publicBaseUrl: 'https://cp.example.com', allowInsecurePrivateNetwork: false,
  }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: 'https', host: 'cp.example.com', origin: 'https://wrong.example.com', remoteAddress: '203.0.113.5',
    publicBaseUrl: 'https://cp.example.com', allowInsecurePrivateNetwork: false,
  }), false);
});
