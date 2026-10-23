const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/set-release-version.mjs');
const manifestCheck = path.resolve(__dirname, '../scripts/check-release-manifest.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-release-'));
  const appJson = path.join(root, 'app.json');
  fs.writeFileSync(appJson, `${JSON.stringify({
    expo: {
      version: '0.0.1',
      ios: { supportsTablet: true },
      android: { package: 'com.taskhandoff.mobile.dev' },
    },
  }, null, 2)}\n`);
  return { root, appJson };
}

describe('mobile release configuration', () => {
  test('writes the stable app version and one build number for both platforms', () => {
    const value = fixture();
    try {
      execFileSync(process.execPath, [script, '1.2.3', '42'], {
        env: {
          ...process.env,
          TASK_HANDOFF_MOBILE_APP_JSON: value.appJson,
        },
      });
      const config = JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo;
      expect(config.version).toBe('1.2.3');
      expect(config.ios).toEqual({ supportsTablet: true, buildNumber: '42' });
      expect(config.android).toEqual({ package: 'com.taskhandoff.mobile.dev', versionCode: 42 });
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.each(['1.2.3-beta.1', '01.2.3', '1.2'])('rejects unsupported release version %s', (version) => {
    const value = fixture();
    try {
      expect(() => execFileSync(process.execPath, [script, version, '42'], {
        env: { ...process.env, TASK_HANDOFF_MOBILE_APP_JSON: value.appJson },
        stdio: 'pipe',
      })).toThrow();
      const config = JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo;
      expect(config.version).toBe('0.0.1');
      expect(config.ios.buildNumber).toBeUndefined();
      expect(config.android.versionCode).toBeUndefined();
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.each(['', '0', '01', '1.2', '2100000001'])('rejects unsupported build number %s', (buildNumber) => {
    const value = fixture();
    try {
      expect(() => execFileSync(process.execPath, [script, '1.2.3', buildNumber], {
        env: { ...process.env, TASK_HANDOFF_MOBILE_APP_JSON: value.appJson },
        stdio: 'pipe',
      })).toThrow();
      const config = JSON.parse(fs.readFileSync(value.appJson, 'utf8')).expo;
      expect(config.version).toBe('0.0.1');
      expect(config.ios.buildNumber).toBeUndefined();
      expect(config.android.versionCode).toBeUndefined();
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
});

describe('mobile release artifact manifest', () => {
  function releaseManifest() {
    return {
      name: 'TaskHandoff',
      scheme: 'taskhandoff',
      version: '1.2.3',
      ios: { bundleIdentifier: 'com.taskhandoff.mobile', buildNumber: '42' },
      android: { package: 'com.taskhandoff.mobile', versionCode: 42, usesCleartextTraffic: false },
      extra: {
        variant: 'production',
        featureFlags: { officialAccount: true },
        cloudEnvironment: {
          id: 'production',
          serviceOrigin: 'https://cloud.thandoff.com',
          coordinatorHostSuffixes: ['thandoff.com', 'xpbox.cn', 'aaasu.com'],
          relayHostSuffixes: ['thandoff.com', 'xpbox.cn', 'aaasu.com'],
          allowInsecureRelay: false,
        },
        cloudDiscovery: {
          record: '_cloud.thandoff.com',
          fallbackOrigin: 'https://cloud.thandoff.com',
          allowedHostSuffixes: ['thandoff.com', 'xpbox.cn', 'aaasu.com'],
        },
      },
    };
  }

  function environment() {
    return {
      ...process.env,
      RELEASE_VERSION: '1.2.3',
      RELEASE_BUILD_NUMBER: '42',
      TASK_HANDOFF_CLOUD_ENV: 'production',
      TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: 'https://cloud.thandoff.com',
      TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: 'thandoff.com,xpbox.cn,aaasu.com',
      TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: 'thandoff.com,xpbox.cn,aaasu.com',
      TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: '0',
      TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: '_cloud.thandoff.com',
      TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN: 'https://cloud.thandoff.com',
    };
  }

  test('accepts the production variant with the official cloud identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-manifest-'));
    const manifestPath = path.join(root, 'app.config');
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(releaseManifest()));
      expect(() => execFileSync(process.execPath, [manifestCheck, manifestPath], {
        env: environment(),
        stdio: 'pipe',
      })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a development manifest even when the native shell is signed for production', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-manifest-'));
    const manifestPath = path.join(root, 'app.config');
    try {
      const manifest = releaseManifest();
      manifest.extra.variant = 'development';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => execFileSync(process.execPath, [manifestCheck, manifestPath], {
        env: environment(),
        stdio: 'pipe',
      })).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a production manifest that does not contain the official cloud identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handoff-mobile-manifest-'));
    const manifestPath = path.join(root, 'app.config');
    try {
      const manifest = releaseManifest();
      manifest.extra.cloudEnvironment.serviceOrigin = 'https://cloud.invalid';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => execFileSync(process.execPath, [manifestCheck, manifestPath], {
        env: environment(),
        stdio: 'pipe',
      })).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
