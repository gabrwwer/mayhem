
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import * as crypto from 'crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import * as fs from 'fs';
import type { BotConfig } from '@mayhem/config';
import bs58 from 'bs58';

export interface WalletProvider {
  getPublicKey(): string;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
  signVersionedTransaction?(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAGIC = Buffer.from('MAYHEMKY1'); // 8 bytes: magic + version

export class EncryptedLocalWallet implements WalletProvider {
  private keypair: Keypair;

  private constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  private static deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  static create(password: string, filePath: string, id = basename(filePath)): EncryptedLocalWallet {
    const keypair = Keypair.generate();
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = EncryptedLocalWallet.deriveKey(password, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(keypair.secretKey),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const payload = Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, payload, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    return new EncryptedLocalWallet(keypair);
  }

  static load(filePath: string, password: string, id = basename(filePath)): EncryptedLocalWallet {
    const payload = fs.readFileSync(filePath);
    if (payload.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new Error('unrecognized wallet file');
    }

    const magic = payload.subarray(0, MAGIC.length);
    if (!magic.equals(MAGIC)) {
      throw new Error('unrecognized wallet file');
    }

    const saltStart = MAGIC.length;
    const salt = payload.subarray(saltStart, saltStart + SALT_LENGTH);
    const ivStart = saltStart + SALT_LENGTH;
    const iv = payload.subarray(ivStart, ivStart + IV_LENGTH);
    const authTagStart = ivStart + IV_LENGTH;
    const authTag = payload.subarray(authTagStart, authTagStart + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(authTagStart + AUTH_TAG_LENGTH);

    const key = EncryptedLocalWallet.deriveKey(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(id, 'utf8'));
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    try {
      const keypair = Keypair.fromSecretKey(new Uint8Array(decrypted));
      return new EncryptedLocalWallet(keypair);
    } finally {
      decrypted.fill(0);
    }
  }

  getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.partialSign(this.keypair);
    return tx;
  }

  async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
    for (const tx of txs) {
      tx.partialSign(this.keypair);
    }
    return txs;
  }

  async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

export class EnvSecretWallet implements WalletProvider {
  private keypair: Keypair;

  constructor() {
    const nodeEnv = (process.env['NODE_ENV'] ?? '').toLowerCase();
    if (nodeEnv === 'production') {
      throw new Error(
        'EnvSecretWallet is forbidden in production â€” use encrypted_local with KEYVAULT_DIR + password',
      );
    }

    const secret = process.env['WALLET_SECRET'];
    if (!secret) {
      throw new Error('WALLET_SECRET environment variable not set');
    }
    this.keypair = Keypair.fromSecretKey(bs58.decode(secret));
    console.warn('[EnvSecretWallet] WARNING: Loading wallet from environment variable is insecure. Use EncryptedLocalWallet for production.');
  }

  getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.partialSign(this.keypair);
    return tx;
  }

  async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
    for (const tx of txs) {
      tx.partialSign(this.keypair);
    }
    return txs;
  }

  async signVersionedTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

export class ExternalSignerWallet implements WalletProvider {
  private signerUrl: string;

  constructor(signerUrl: string) {
    if (!signerUrl) {
      throw new Error('ExternalSignerWallet requires signerUrl to be configured');
    }
    this.signerUrl = signerUrl;
  }

  getPublicKey(): string {
    throw new Error('External signer not configured - implement HSM/hardware wallet integration');
  }

  async signTransaction(_tx: Transaction): Promise<Transaction> {
    throw new Error('External signer not configured - implement HSM/hardware wallet integration');
  }

  async signAllTransactions(_txs: Transaction[]): Promise<Transaction[]> {
    throw new Error('External signer not configured - implement HSM/hardware wallet integration');
  }
}

export type WalletProviderType = 'encrypted_local' | 'env_secret' | 'external_signer';

export interface WalletFactoryOptions {
  password?: string;
  filePath?: string;
  signerUrl?: string;
  walletId?: string;
}

export class WalletFactory {
  static create(provider: WalletProviderType, options: WalletFactoryOptions = {}): WalletProvider {
    switch (provider) {
      case 'encrypted_local':
        if (!options.filePath || !options.password) {
          throw new Error('encrypted_local requires filePath and password');
        }
        if (fs.existsSync(options.filePath)) {
          return EncryptedLocalWallet.load(options.filePath, options.password, options.walletId);
        }
        return EncryptedLocalWallet.create(options.password, options.filePath, options.walletId);

      case 'env_secret':
        return new EnvSecretWallet();

      case 'external_signer':
        return new ExternalSignerWallet(options.signerUrl ?? '');

      default:
        throw new Error(`Unknown wallet provider: ${provider}`);
    }
  }
}

export function walletFromConfig(cfg: BotConfig, password: string): WalletProvider {
  const { keyvaultDir, hotWalletId } = cfg.wallets;
  if (!keyvaultDir || !hotWalletId) {
    throw new Error('walletFromConfig requires cfg.wallets.keyvaultDir and cfg.wallets.hotWalletId');
  }
  const filePath = join(keyvaultDir, `${hotWalletId}.key`);
  return EncryptedLocalWallet.load(filePath, password, hotWalletId);
}