import { CLOUD_PRODUCTION_ORIGIN } from '../src/control-plane/cloud-account';
import { allowCloudRelayUrlForService } from '../src/control-plane/relay-channel';
import { CLOUD_ENVIRONMENTS } from '../../../shared/cloud-environments.cjs';

function loadBuildVariant(extra: Record<string, unknown>) {
  jest.resetModules();
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra } } }));
  return require('../src/platform/build-variant') as typeof import('../src/platform/build-variant');
}

describe('mobile cloud connectivity', () => {
  afterEach(() => {
    jest.dontMock('expo-constants');
    jest.resetModules();
  });

  test('production cloud connectivity trusts the configured service and Relay domains', () => {
    expect(CLOUD_PRODUCTION_ORIGIN).toBe('https://cloud.thandoff.com');
    expect(allowCloudRelayUrlForService(new URL('wss://eu.relay.thandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(true);
    expect(allowCloudRelayUrlForService(new URL('wss://relay.th.xpbox.cn/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(true);
    expect(allowCloudRelayUrlForService(new URL('wss://hk.relay.th.xpbox.cn/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(true);
    expect(allowCloudRelayUrlForService(new URL('wss://relay.aaasu.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(true);
    expect(allowCloudRelayUrlForService(new URL('wss://relay.taskhandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(false);
    expect(allowCloudRelayUrlForService(new URL('wss://eu.relay.taskhandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(false);
    expect(allowCloudRelayUrlForService(new URL('wss://relay.th.xpbox.cn.evil.test/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(false);
  });

  test('the production fallback for legacy manifests mirrors the shared environment definition', () => {
    const variant = loadBuildVariant({ variant: 'production' });
    expect(variant.mobileCloudEnvironment).toEqual(CLOUD_ENVIRONMENTS.production);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://cloud.thandoff.com')).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay1.relay.aaasu.com/connect'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay.th.xpbox.cn/connect'))).toBe(true);
  });

  test('a staging build trusts the baked test domains only', () => {
    const variant = loadBuildVariant({ variant: 'staging', cloudEnvironment: CLOUD_ENVIRONMENTS.staging });
    const { allowCloudRelayUrlForService: allowForBakedEnvironment } = require('../src/control-plane/relay-channel') as typeof import('../src/control-plane/relay-channel');
    expect(variant.isTrustedMobileCloudServiceOrigin('https://th.aaasu.com')).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay1.relay.aaasu.com/connect'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay.thandoff.com/connect'))).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('ws://relay1.relay.aaasu.com/connect'))).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay9.relay.example.com/connect'))).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay.aaasu.com.evil.test/connect'))).toBe(false);
    expect(allowForBakedEnvironment(new URL('wss://relay1.relay.aaasu.com/connect'), 'https://th.aaasu.com', true)).toBe(true);
    expect(allowForBakedEnvironment(new URL('wss://relay.aaasu.com.evil.test/connect'), 'https://th.aaasu.com', true)).toBe(false);
  });

  test('a legacy manifest without a baked environment derives trust from its service origin', () => {
    const variant = loadBuildVariant({ variant: 'staging', cloudServiceOrigin: 'https://staging.cloud.example.test' });
    expect(variant.isTrustedMobileCloudServiceOrigin('https://staging.cloud.example.test')).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://staging.cloud.example.test/connect'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(new URL('wss://relay1.relay.aaasu.com/connect'))).toBe(false);
  });

  test('discovery-enabled builds trust only their declared host suffixes', () => {
    const variant = loadBuildVariant({
      variant: 'production',
      cloudEnvironment: CLOUD_ENVIRONMENTS.production,
      cloudDiscovery: {
        record: '_cloud.thandoff.com',
        fallbackOrigin: 'https://cloud.thandoff.com',
        allowedHostSuffixes: ['thandoff.com'],
      },
    });
    expect(variant.mobileCloudDiscoveryConfig).toEqual({
      record: '_cloud.thandoff.com',
      fallbackOrigin: 'https://cloud.thandoff.com',
      allowedHostSuffixes: ['thandoff.com'],
    });
    expect(variant.isTrustedMobileCloudServiceOrigin('https://cloud-backup.thandoff.com')).toBe(true);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://thandoff.com.evil.test')).toBe(false);
    expect(variant.isTrustedMobileCloudServiceOrigin('http://cloud-backup.thandoff.com')).toBe(false);
  });

  test('a legacy manifest pointing at a registered origin keeps its declared Relay hosts', () => {
    const staging = loadBuildVariant({ variant: 'staging', cloudServiceOrigin: 'https://th.aaasu.com' });
    expect(staging.mobileCloudEnvironment).toEqual(CLOUD_ENVIRONMENTS.staging);
    expect(staging.isTrustedMobileCloudRelayUrl(new URL('wss://relay.aaasu.com/connect'))).toBe(true);
    expect(staging.isTrustedMobileCloudRelayUrl(new URL('wss://th.aaasu.com/connect'))).toBe(false);
  });
});
