import { readFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface WalletLoaderLogger {
  info(message: string, context?: Record<string, unknown>): void;
}

function parseSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('wallet keypair is malformed');

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      Array.isArray(parsed) &&
      parsed.length === 64 &&
      parsed.every(
        (value) =>
          Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255,
      )
    ) {
      return Uint8Array.from(parsed as number[]);
    }
  } catch {
    // Try base58 below.
  }

  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) throw new Error('invalid wallet keypair length');
    return decoded;
  } catch {
    throw new Error('wallet keypair is malformed');
  }
}

export async function loadLiveWallet(
  env: NodeJS.ProcessEnv,
  log?: WalletLoaderLogger,
): Promise<Keypair> {
  const keypairPath = env['WALLET_KEYPAIR_PATH']?.trim();
  const inlineKeypair = env['SOLANA_KEYPAIR'];

  if (keypairPath && inlineKeypair) {
    throw new Error('configure only one live wallet source');
  }
  if (!keypairPath && !inlineKeypair) {
    throw new Error('live wallet is not configured');
  }

  const encoded = keypairPath
    ? await readFile(keypairPath, 'utf8').catch(() => {
        throw new Error('live wallet file could not be read');
      })
    : inlineKeypair!;

  try {
    const keypair = Keypair.fromSecretKey(parseSecret(encoded));
    if (!keypair.publicKey) throw new Error('wallet public key unavailable');
    log?.info('LIVE_WALLET_LOADED', {
      publicKey: keypair.publicKey.toBase58(),
    });
    return keypair;
  } catch {
    throw new Error('wallet keypair is invalid');
  }
}
