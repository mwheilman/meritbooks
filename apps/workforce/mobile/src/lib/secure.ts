/**
 * The phone's storage key: 256 random bits made on first use and kept ONLY in the platform key
 * store (iOS Keychain / Android Keystore via expo-secure-store, this device only, readable after
 * the first unlock). The files themselves are NSFileProtectionComplete on iOS (app.json), so the
 * app reads and sends only while the phone is unlocked — it never syncs in the background. It encrypts:
 *   - the SQLite file itself, with SQLCipher (development and store builds; Expo Go has no SQLCipher)
 *   - the payload columns (commands, server answers, cached work) with AES-256-GCM, everywhere
 * Signing out deletes the key, the database and the photos, so nothing left behind can be read.
 */
import { AESEncryptionKey, AESKeySize, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createSealer, type Sealer } from '@/core/sealed';

const KEY_NAME = 'merit-workforce.storage-key.v1';
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

interface Keys {
  hex: string;
  aes: AESEncryptionKey;
}

let loading: Promise<Keys> | null = null;

function keys(): Promise<Keys> {
  loading ??= (async () => {
    let hex = await SecureStore.getItemAsync(KEY_NAME, OPTS);
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
      const fresh = await AESEncryptionKey.generate(AESKeySize.AES256);
      hex = await fresh.encoded('hex');
      await SecureStore.setItemAsync(KEY_NAME, hex, OPTS);
      return { hex, aes: fresh };
    }
    return { hex, aes: await AESEncryptionKey.import(hex, 'hex') };
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Raw 256-bit key as 64 hex characters, for SQLCipher's `PRAGMA key = "x'…'"`. */
export async function databaseKeyHex(): Promise<string> {
  return (await keys()).hex;
}

export const sealer: Sealer = createSealer({
  async encrypt(plain) {
    const sealed = await aesEncryptAsync(plain, (await keys()).aes);
    return sealed.combined('base64');
  },
  async decrypt(combined) {
    return aesDecryptAsync(AESSealedData.fromCombined(combined), (await keys()).aes, { output: 'bytes' });
  },
});

/** Crypto-shred: after this, anything sealed with the old key is unreadable. */
export async function forgetStorageKey(): Promise<void> {
  loading = null;
  await SecureStore.deleteItemAsync(KEY_NAME, OPTS).catch(() => undefined);
}
