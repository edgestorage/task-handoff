import * as SecureStore from 'expo-secure-store';

export interface ValueStore {
  available(): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type SecureValueStore = ValueStore;

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'com.taskhandoff.mobile.credentials',
};

export class ExpoSecureValueStore implements SecureValueStore {
  constructor(private readonly namespace = 'taskhandoff') {}

  available() {
    return SecureStore.isAvailableAsync();
  }

  async get(key: string) {
    return (await SecureStore.getItemAsync(this.storageKey(key), OPTIONS)) ?? undefined;
  }

  async set(key: string, value: string) {
    await SecureStore.setItemAsync(this.storageKey(key), value, OPTIONS);
  }

  async remove(key: string) {
    await SecureStore.deleteItemAsync(this.storageKey(key), OPTIONS);
  }

  private storageKey(key: string) {
    if (!KEY_PATTERN.test(key)) throw new Error('Secure storage keys may contain only letters, numbers, dot, dash and underscore.');
    return `${this.namespace}.${key}`;
  }
}
