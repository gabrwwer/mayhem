import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WalletRotator } from '../wallet-rotator';

describe('Wallet Key Rotation', () => {
  let rotator: WalletRotator;
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    rotator = new WalletRotator(mockLogger);
    vi.clearAllMocks();
  });

  it('should generate a new key version on rotation', async () => {
    const currentPubkey = 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9';

    const result = await rotator.rotate(currentPubkey, {
      dualSignDurationMs: 24 * 60 * 60 * 1000,
    });

    expect(result.previousVersion).toBe(1);
    expect(result.newVersion).toBe(2);
    expect(result.publicKeyChanged).toBe(true);
    expect(result.publicKeysMapping.v1).toBe(currentPubkey);
    expect(result.publicKeysMapping.v2).not.toBe(currentPubkey);
  });

  it('should set dual-sign period', async () => {
    const currentPubkey = 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9';
    const dualSignDurationMs = 24 * 60 * 60 * 1000;

    const result = await rotator.rotate(currentPubkey, { dualSignDurationMs });

    expect(result.dualSignEndsAt).toBeGreaterThan(result.timestamp);
    expect(result.dualSignEndsAt).toBe(result.timestamp + dualSignDurationMs);
  });

  it('should use default 24-hour dual-sign period', async () => {
    const currentPubkey = 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9';

    const result = await rotator.rotate(currentPubkey, {});

    const expectedDuration = 24 * 60 * 60 * 1000;
    expect(result.dualSignEndsAt - result.timestamp).toBe(expectedDuration);
  });

  it('should log rotation events', async () => {
    const currentPubkey = 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9';

    await rotator.rotate(currentPubkey, {});

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Wallet key rotation initialized',
      expect.objectContaining({ currentPublicKey: currentPubkey }),
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Wallet rotation completed',
      expect.objectContaining({ newPublicKey: expect.any(String) }),
    );
  });

  it('should track timestamp of rotation', async () => {
    const currentPubkey = 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9';
    const beforeRotation = Date.now();

    const result = await rotator.rotate(currentPubkey, {});

    expect(result.timestamp).toBeGreaterThanOrEqual(beforeRotation);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
  });

  describe('isKeyValid', () => {
    it('should accept active version key', () => {
      const activeVersion = {
        version: 1,
        publicKey: 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9',
        createdAt: Date.now(),
        status: 'active' as const,
      };

      expect(rotator.isKeyValid(activeVersion.publicKey, activeVersion)).toBe(true);
    });

    it('should accept key during dual-sign period', () => {
      const activeVersion = {
        version: 2,
        publicKey: 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9',
        createdAt: Date.now(),
        status: 'active' as const,
      };

      const oldKey = 'HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn';
      const futureTime = Date.now() + 60 * 60 * 1000; // 1 hour from now

      expect(
        rotator.isKeyValid(oldKey, activeVersion, { endsAt: futureTime })
      ).toBe(true);
    });

    it('should reject key after dual-sign period expires', () => {
      const activeVersion = {
        version: 2,
        publicKey: 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9',
        createdAt: Date.now(),
        status: 'active' as const,
      };

      const oldKey = 'HFqU5x63VTtX1S2D5bDMsKA8p8RfsTG8dvhdQFgSrCQn';
      const pastTime = Date.now() - 60 * 1000; // 1 minute ago

      expect(
        rotator.isKeyValid(oldKey, activeVersion, { endsAt: pastTime })
      ).toBe(false);
    });

    it('should reject unknown key outside dual-sign period', () => {
      const activeVersion = {
        version: 2,
        publicKey: 'DZjycnDFDCI6NMeiLqXS7JJYWfRwVWmj99ThpZjSLwQ9',
        createdAt: Date.now(),
        status: 'active' as const,
      };

      const unknownKey = 'ADaUvJ46Lw8Q3PjYo5KEcsSYajcg4CB54sSQcWQ43V5m';

      expect(rotator.isKeyValid(unknownKey, activeVersion)).toBe(false);
    });
  });
});
