const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/set-release-version.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-release-'));
  const appJson = path.join(root, 'app.json');
  fs.writeFileSync(appJson, `${JSON.stringify({ expo: { version: '0.0.1' } }, null, 2)}\n`);
  return { root, appJson };
}

describe('mobile release configuration', () => {
  test('writes the stable app version', () => {
    const value = fixture();
    try {
      execFileSync(process.execPath, [script, '1.2.3'], {
        env: {
          ...process.env,
          TASK_HANDOFF_MOBILE_APP_JSON: value.appJson,
        },
      });
      expect(JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo.version).toBe('1.2.3');
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
