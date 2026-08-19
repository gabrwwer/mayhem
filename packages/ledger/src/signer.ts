
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Signing boundary for the ledger.
 *
 * Deliberately narrow: production signing is expected to happen in a KMS or
 * HSM, and the ledger must not care whether the key material is local. An
 * implementation is given the digest to sign and nothing else.
 */
export interface LedgerSigner {
  readonly keyId: string;
  sign(digestHex: string): string;
}

export interface LedgerVerifier {
  verify(digestHex: string, signature: string, keyId: string): boolean;
}

/**
 * Ed25519 signer backed by an in-process key. Suitable for tests, development
 * and paper trading; production must use a KMS/HSM-backed implementation.
 */
export class LocalEd25519Signer implements LedgerSigner, LedgerVerifier {
  readonly keyId: string;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  constructor(keyId: string, privateKeyPem: string) {
    this.keyId = keyId;
    this.#privateKey = createPrivateKey(privateKeyPem);
    this.#publicKey = createPublicKey(this.#privateKey);
  }

  static generate(keyId: string): LocalEd25519Signer {
    const { privateKey } = generateKeyPairSync('ed25519');

    return new LocalEd25519Signer(
      keyId,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
  }

  get publicKeyPem(): string {
    return this.#publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  sign(digestHex: string): string {
    return signBytes(null, Buffer.from(digestHex, 'utf8'), this.#privateKey).toString('base64');
  }

  verify(digestHex: string, signature: string, keyId: string): boolean {
    if (keyId !== this.keyId) return false;

    try {
      return verifyBytes(
        null,
        Buffer.from(digestHex, 'utf8'),
        this.#publicKey,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      // A malformed signature is a failed verification, never an outage.
      return false;
    }
  }
}