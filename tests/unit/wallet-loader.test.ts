import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { loadLiveWallet } from '../../apps/bot/src/wallet-loader';

describe('loadLiveWallet', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mayhem-wallet-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects a missing wallet path', async () => {
    await expect(loadLiveWallet({})).rejects.toThrow('live wallet is not configured');
  });

  it('rejects a nonexistent wallet file', async () => {
    await expect(
      loadLiveWallet({ WALLET_KEYPAIR_PATH: path.join(tempDir, 'missing.json') }),
    ).rejects.toThrow('live wallet file could not be read');
  });

  it('rejects malformed keypair data', async () => {
    const file = path.join(tempDir, 'wallet.json');
    await writeFile(file, 'not-a-keypair');

    await expect(loadLiveWallet({ WALLET_KEYPAIR_PATH: file })).rejects.toThrow(
      'wallet keypair is invalid',
    );
  });

  it('rejects an invalid keypair length', async () => {
    const file = path.join(tempDir, 'wallet.json');
    await writeFile(file, JSON.stringify([1, 2, 3]));

    await expect(loadLiveWallet({ WALLET_KEYPAIR_PATH: file })).rejects.toThrow(
      'wallet keypair is invalid',
    );
  });

  it('loads a valid keypair and logs only its public address', async () => {
    const keypair = Keypair.generate();
    const secret = Array.from(keypair.secretKey);
    const file = path.join(tempDir, 'wallet.json');
    await writeFile(file, JSON.stringify(secret));
    const log = vi.fn();

    const loaded = await loadLiveWallet(
      { WALLET_KEYPAIR_PATH: file },
      { info: log },
    );

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(log).toHaveBeenCalledWith('LIVE_WALLET_LOADED', {
      publicKey: keypair.publicKey.toBase58(),
    });
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).toContain(keypair.publicKey.toBase58());
    expect(serializedLogs).not.toContain(JSON.stringify(secret));
  });

  it('does not log secret material when the wallet is valid', async () => {
    const keypair = Keypair.generate();
    const file = path.join(tempDir, 'wallet.json');
    await writeFile(file, JSON.stringify(Array.from(keypair.secretKey)));
    const log = vi.fn();

    await loadLiveWallet({ WALLET_KEYPAIR_PATH: file }, { info: log });

    for (const call of log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secretKey');
      expect(JSON.stringify(call)).not.toContain(JSON.stringify(Array.from(keypair.secretKey)));
    }
  });
});
