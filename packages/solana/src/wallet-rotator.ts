import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

export interface KeyVersion {
  version: number;
  publicKey: string;
  createdAt: number;
  rotatedAt?: number;
  status: 'active' | 'deprecated' | 'revoked';
}

export interface WalletRotationConfig {
  dualSignDurationMs?: number;   // How long both keys are valid (default: 24h)
}

export interface RotationResult {
  timestamp: number;
  previousVersion: number;
  newVersion: number;
  dualSignEndsAt: number;
  publicKeyChanged: boolean;
  publicKeysMapping: {
    v1: string;
    v2: string;
  };
}

export class WalletRotator {
  constructor(
    private readonly logger?: { 
      info: (msg: string, data?: any) => void; 
      error: (msg: string, data?: any) => void;
    },
  ) {}

  /**
   * Rotate wallet key (generate new keypair, keep old for compatibility)
   * 
   * In a real implementation, this would:
   * 1. Load current wallet from encrypted file
   * 2. Generate new keypair
   * 3. Update wallet file with new keypair
   * 4. Create dual-sign period record in database
   * 5. Backup old wallet file
   * 
   * For now, this is a schema/interface definition for the database layer.
   */
  async rotate(
    currentPublicKey: string,
    config: WalletRotationConfig,
  ): Promise<RotationResult> {
    const startTime = Date.now();

    this.logger?.info('Wallet key rotation initialized', {
      currentPublicKey,
      dualSignDurationMs: config.dualSignDurationMs ?? 24 * 60 * 60 * 1000,
    });

    // Generate new keypair (in real impl, would be stored encrypted)
    const newKeypair = Keypair.generate();
    const newPublicKey = newKeypair.publicKey.toBase58();

    const rotationRecord: RotationResult = {
      timestamp: startTime,
      previousVersion: 1,
      newVersion: 2,
      dualSignEndsAt: startTime + (config.dualSignDurationMs ?? 24 * 60 * 60 * 1000),
      publicKeyChanged: currentPublicKey !== newPublicKey,
      publicKeysMapping: {
        v1: currentPublicKey,
        v2: newPublicKey,
      },
    };

    this.logger?.info('Wallet rotation completed', {
      newPublicKey,
      dualSignEndsAt: new Date(rotationRecord.dualSignEndsAt).toISOString(),
    });

    return rotationRecord;
  }

  /**
   * Check if a public key is currently valid (active or in dual-sign period)
   */
  isKeyValid(publicKey: string, activeVersion: KeyVersion, dualSignPeriod?: { endsAt: number }): boolean {
    // Active version is always valid
    if (publicKey === activeVersion.publicKey) {
      return true;
    }

    // Check if in dual-sign period
    if (dualSignPeriod && Date.now() < dualSignPeriod.endsAt) {
      return true; // Still in dual-sign window
    }

    return false;
  }
}
