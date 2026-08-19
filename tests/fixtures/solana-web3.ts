
export class PublicKey {
  private readonly value: string;

  constructor(value: string) {
    this.value = String(value);
  }

  toBase58(): string {
    return this.value;
  }

  toString(): string {
    return this.value;
  }

  equals(other: PublicKey): boolean {
    return this.value === other.toBase58();
  }
}

export class Connection {
  constructor(
    public readonly endpoint: string,
    public readonly commitment?: unknown,
  ) {}

  async getBalance(): Promise<number> {
    return 0;
  }

  async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: "test-blockhash",
      lastValidBlockHeight: 0,
    };
  }
}

export const LAMPORTS_PER_SOL = 1_000_000_000;