import { mobileDeviceIdentity, deviceDisplayName } from '../src/control-plane/mobile-device';
import Constants from 'expo-constants';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { deviceName: '  Alice\nPixel  9  ', expoConfig: { version: '1.2.3' } },
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digest: jest.fn(),
  randomUUID: jest.fn(() => 'generated-device-id'),
}));

function secureStore() {
  return {
    available: jest.fn(async () => true),
    get: jest.fn(async (key: string) => key === 'mobile-device-id' ? 'device-test' : undefined),
    set: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
}

describe('mobile device identity', () => {
  beforeEach(() => {
    (Constants as { deviceName?: string }).deviceName = '  Alice\nPixel  9  ';
  });

  test('reports a cleaned system device name without changing the installation id', async () => {
    const store = secureStore();
    const identity = await mobileDeviceIdentity(store);
    expect(identity.id).toBe('device-test');
    expect(identity.descriptor).toMatchObject({ name: 'Alice Pixel 9', kind: 'mobile', version: '1.2.3' });
    expect(store.set).not.toHaveBeenCalled();
  });

  test('falls back to a platform label when the system name is unavailable', async () => {
    (Constants as { deviceName?: string }).deviceName = undefined;
    const identity = await mobileDeviceIdentity(secureStore());
    expect(identity.descriptor.name).toMatch(/^TaskHandoff on (iOS|Android)$/);
  });

  test('removes control characters and bounds the reported name', () => {
    expect(deviceDisplayName(' \u0000 Phone\tName \u007f ')).toBe('Phone Name');
    expect(deviceDisplayName('x'.repeat(200))).toHaveLength(160);
    expect(deviceDisplayName(' \n ')).toBeUndefined();
  });
});
