const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/set-release-version.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-release-'));
  const appJson = path.join(root, 'app.json');
  const easJson = path.join(root, 'eas.json');
  fs.writeFileSync(appJson, `${JSON.stringify({ expo: { version: '0.0.1' } }, null, 2)}\n`);
  fs.writeFileSync(easJson, `${JSON.stringify({ submit: { production: { ios: {} } } }, null, 2)}\n`);
  return { root, appJson, easJson };
}

describe('mobile release configuration', () => {
  test('writes the stable app version and App Store Connect app id', () => {
    const value = fixture();
    try {
      execFileSync(process.execPath, [script, '1.2.3', '1234567890'], {
        env: {
          ...process.env,
          TASK_HANDOFF_MOBILE_APP_JSON: value.appJson,
          TASK_HANDOFF_MOBILE_EAS_JSON: value.easJson,
        },
      });
      expect(JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo.version).toBe('1.2.3');
      expect(JSON.parse(fs.readFileSync(value.easJson, 'utf8')).submit.production.ios.ascAppId).toBe('1234567890');
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.each(['1.2.3-beta.1', '01.2.3', '1.2'])('rejects unsupported release version %s', (version) => {
    const value = fixture();
    try {
      expect(() => execFileSync(process.execPath, [script, version], {
        env: { ...process.env, TASK_HANDOFF_MOBILE_APP_JSON: value.appJson },
        stdio: 'pipe',
      })).toThrow();
      expect(JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo.version).toBe('0.0.1');
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
});
