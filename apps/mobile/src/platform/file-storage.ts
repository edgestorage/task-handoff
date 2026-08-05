import { Directory, File, Paths } from 'expo-file-system';
import nacl from 'tweetnacl';

import type { ValueStore } from './secure-storage';

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Non-secret app data that can exceed native Keychain/Keystore value limits. */
export class ExpoFileValueStore implements ValueStore {
  private readonly directory: Directory;

  constructor(namespace = 'taskhandoff-data') {
    this.directory = new Directory(Paths.document, namespace);
  }

  async available() {
    try {
      this.ensureDirectory();
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string) {
    const file = this.file(key);
    return file.exists ? file.text() : undefined;
  }

  async set(key: string, value: string) {
    this.ensureDirectory();
    const file = this.file(key);
    const temporary = new File(this.directory, `${file.name}.tmp`);
    if (temporary.exists) temporary.delete();
    temporary.create();
    temporary.write(value);
    await temporary.move(file, { overwrite: true });
  }

  async remove(key: string) {
    const file = this.file(key);
    if (file.exists) file.delete();
  }

  private ensureDirectory() {
    this.directory.create({ idempotent: true, intermediates: true });
  }

  private file(key: string) {
    if (!KEY_PATTERN.test(key)) throw new Error('File storage keys may contain only letters, numbers, dot, dash and underscore.');
    const digest = nacl.hash(new TextEncoder().encode(key)).slice(0, 32);
    const name = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return new File(this.directory, `${name}.json`);
  }
}
