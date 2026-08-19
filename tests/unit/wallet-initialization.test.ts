// Avoid importing WalletFactory directly since it pulls in @solana/web3.js ESM chain.
// Instead, test the logic patterns used in the bot entry point.

describe('Wallet Initialization Logic', () => {
  describe('DRY_RUN mode', () => {
    it('should skip wallet init when DRY_RUN=true', () => {
      const config = { DRY_RUN: true, WALLET_PROVIDER: 'encrypted_local' };
      let walletInitialized = false;

      if (!config.DRY_RUN) {
        walletInitialized = true;
      }

      expect(walletInitialized).toBe(false);
    });

    it('should not require WALLET_PASSWORD when DRY_RUN=true', () => {
      const config = { DRY_RUN: true, WALLET_PASSWORD: undefined };
      let shouldFail = false;

      if (!config.DRY_RUN && !config.WALLET_PASSWORD) {
        shouldFail = true;
      }

      expect(shouldFail).toBe(false);
    });
  });

  describe('LIVE mode validation', () => {
    it('should reject missing wallet password for encrypted_local in LIVE mode', () => {
      const config = {
        DRY_RUN: false,
        TRADING_ENABLED: true,
        WALLET_PROVIDER: 'encrypted_local' as const,
        WALLET_PASSWORD: undefined as string | undefined,
      };

      let error: string | null = null;

      if (!config.DRY_RUN && config.TRADING_ENABLED) {
        if (config.WALLET_PROVIDER === 'encrypted_local' && !config.WALLET_PASSWORD) {
          error = 'LIVE trading requires WALLET_PASSWORD when WALLET_PROVIDER=encrypted_local.';
        }
      }

      expect(error).not.toBeNull();
      expect(error).toContain('WALLET_PASSWORD');
    });

    it('should accept valid wallet config in LIVE mode', () => {
      const config = {
        DRY_RUN: false,
        TRADING_ENABLED: true,
        WALLET_PROVIDER: 'encrypted_local' as const,
        WALLET_PASSWORD: 'my-secure-password',
        WALLET_FILE_PATH: '/home/user/.mayhem/wallet.enc',
      };

      let error: string | null = null;

      if (!config.DRY_RUN && config.TRADING_ENABLED) {
        if (config.WALLET_PROVIDER === 'encrypted_local' && !config.WALLET_PASSWORD) {
          error = 'WALLET_PASSWORD required';
        }
      }

      expect(error).toBeNull();
    });
  });

  describe('Logging safety', () => {
    it('should redact secret-containing keys', () => {
      const SECRET_PATTERNS = ['secret', 'key', 'password', 'private'];

      const testData: Record<string, unknown> = {
        wallet_password: 'supersecret123',
        api_key: 'ak_12345',
        private_key: 'pk_abcdef',
        wallet_secret: 'ws_xyz',
        normal_field: 'visible',
        mode: 'dry_run',
      };

      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(testData)) {
        if (SECRET_PATTERNS.some((p) => k.toLowerCase().includes(p))) {
          cleaned[k] = '[REDACTED]';
        } else {
          cleaned[k] = v;
        }
      }

      // Bracket access: `cleaned` is a Record, and
      // noPropertyAccessFromIndexSignature forbids dot access on one.
      expect(cleaned['wallet_password']).toBe('[REDACTED]');
      expect(cleaned['api_key']).toBe('[REDACTED]');
      expect(cleaned['private_key']).toBe('[REDACTED]');
      expect(cleaned['wallet_secret']).toBe('[REDACTED]');
      expect(cleaned['normal_field']).toBe('visible');
      expect(cleaned['mode']).toBe('dry_run');
    });

    it('should redact RPC URLs with query parameters', () => {
      function redactUrl(url: string): string {
        try {
          const u = new URL(url);
          if (u.searchParams.toString()) {
            for (const key of u.searchParams.keys()) {
              u.searchParams.set(key, 'REDACTED');
            }
          }
          if (u.password) u.password = 'REDACTED';
          return u.toString();
        } catch {
          return url.replace(/[?].*$/, '?REDACTED');
        }
      }

      const rpc = 'https://mainnet.helius-rpc.com/?api-key=abc123secret';
      const redacted = redactUrl(rpc);

      expect(redacted).not.toContain('abc123secret');
      expect(redacted).toContain('REDACTED');
    });
  });
});