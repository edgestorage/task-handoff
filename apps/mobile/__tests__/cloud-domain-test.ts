const CLOUD_ENVIRONMENT = {
  id: 'production',
  serviceOrigin: 'https://cloud.example.test',
  coordinatorHostSuffixes: ['example.test'],
  relayHostSuffixes: ['relay.example.test'],
  allowInsecureRelay: false,
} as const;

const CLOUD_DISCOVERY = {
  record: '_cloud.example.test',
  fallbackOrigin: 'https://cloud.example.test',
  allowedHostSuffixes: ['example.test'],
} as const;

function loadBuildVariant(extra: Record<string, unknown>) {
  jest.resetModules();
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra } } }));
  return require('../src/platform/build-variant') as typeof import('../src/platform/build-variant');
}

function relayUrl(host: string) {
  return new URL(`wss://${host}/connect`);
}

describe('mobile cloud connectivity', () => {
  afterEach(() => {
    jest.dontMock('expo-constants');
    jest.resetModules();
  });

  test('a baked environment trusts only its configured Coordinator and Relay suffixes', () => {
    const variant = loadBuildVariant({ variant: 'production', cloudEnvironment: CLOUD_ENVIRONMENT });
    const { allowCloudRelayUrlForService } = require('../src/control-plane/relay-channel') as typeof import('../src/control-plane/relay-channel');
    expect(variant.mobileCloudEnvironment).toEqual(CLOUD_ENVIRONMENT);
    expect(variant.isTrustedMobileCloudServiceOrigin(CLOUD_ENVIRONMENT.serviceOrigin)).toBe(true);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://coordinator.example.test')).toBe(true);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://example.test.evil.test')).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('edge.relay.example.test'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('relay.example.test'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('relay.example.test.evil.test'))).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('coordinator.example.test'))).toBe(false);
    expect(allowCloudRelayUrlForService(relayUrl('edge.relay.example.test'), CLOUD_ENVIRONMENT.serviceOrigin)).toBe(true);
    expect(allowCloudRelayUrlForService(relayUrl('relay.outside.test'), CLOUD_ENVIRONMENT.serviceOrigin)).toBe(false);
  });

  test('an unconfigured manifest fails closed without an embedded production domain', () => {
    const variant = loadBuildVariant({ variant: 'production' });
    expect(variant.mobileCloudEnvironment).toEqual(expect.objectContaining({
      id: 'unconfigured',
      serviceOrigin: 'https://cloud.invalid',
      coordinatorHostSuffixes: [],
      relayHostSuffixes: [],
    }));
    expect(variant.isTrustedMobileCloudServiceOrigin('https://cloud.invalid')).toBe(true);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://cloud.example.test')).toBe(false);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('edge.relay.example.test'))).toBe(false);
  });

  test('a legacy manifest derives an isolated environment from its service origin', () => {
    const variant = loadBuildVariant({ variant: 'staging', cloudServiceOrigin: 'https://staging.cloud.example.test' });
    expect(variant.mobileCloudEnvironment).toEqual(expect.objectContaining({
      id: 'custom',
      serviceOrigin: 'https://staging.cloud.example.test',
      coordinatorHostSuffixes: ['staging.cloud.example.test'],
      relayHostSuffixes: ['staging.cloud.example.test'],
    }));
    expect(variant.isTrustedMobileCloudServiceOrigin('https://staging.cloud.example.test')).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('staging.cloud.example.test'))).toBe(true);
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('relay.example.test'))).toBe(false);
  });

  test('legacy relayHosts cannot widen the main-domain allowlist', () => {
    const variant = loadBuildVariant({
      variant: 'production',
      cloudEnvironment: {
        ...CLOUD_ENVIRONMENT,
        relayHosts: ['relay.outside.test'],
      },
    });
    expect(variant.mobileCloudEnvironment).not.toHaveProperty('relayHosts');
    expect(variant.isTrustedMobileCloudRelayUrl(relayUrl('relay.outside.test'))).toBe(false);
  });

  test('discovery-enabled builds trust only the baked Coordinator suffixes', () => {
    const variant = loadBuildVariant({
      variant: 'production',
      cloudEnvironment: CLOUD_ENVIRONMENT,
      cloudDiscovery: { ...CLOUD_DISCOVERY, allowedHostSuffixes: ['outside.test'] },
    });
    expect(variant.mobileCloudDiscoveryConfig).toEqual({ ...CLOUD_DISCOVERY, allowedHostSuffixes: ['example.test'] });
    expect(variant.isTrustedMobileCloudServiceOrigin('https://backup.example.test')).toBe(true);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://example.test.evil.test')).toBe(false);
    expect(variant.isTrustedMobileCloudServiceOrigin('https://outside.test')).toBe(false);
    expect(variant.isTrustedMobileCloudServiceOrigin('http://backup.example.test')).toBe(false);
  });
});
