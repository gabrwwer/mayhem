
import type { QuoteResult } from '@mayhem/solana';
import { Buffer } from 'node:buffer';
import Decimal from 'decimal.js';

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label: string } }[];
  slippageBps: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
}

export class JupiterClient {
  private apiUrl: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl ?? JUPITER_API;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<QuoteResult> {
    const amountRaw = decimalToRaw(amount, inputMint === SOL_MINT ? 9 : 0);

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'true',
    });

    const data = await this.fetchWithRetry<JupiterQuoteResponse>(
      `${this.apiUrl}/quote?${params.toString()}`,
      { method: 'GET' },
    );

    const inRaw = BigInt(data.inAmount);
    const outRaw = BigInt(data.outAmount);

    if (inRaw <= 0n || outRaw <= 0n) {
      throw new Error(`Jupiter returned invalid amounts: in=${data.inAmount} out=${data.outAmount}`);
    }

    const inputSol = inputMint === SOL_MINT;
    const inHuman = rawToDecimalString(inRaw, inputSol ? 9 : 0);
    const outHuman = rawToDecimalString(outRaw, inputSol ? 0 : 9);
    const price = inputSol
      ? new Decimal(inHuman).div(outHuman)
      : new Decimal(outHuman).div(inHuman);

    return {
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inputAmount: inHuman,
      outputAmount: outHuman,
      inputRawAmount: inRaw,
      outputRawAmount: outRaw,
      pricePerToken: price.toFixed(),
      priceImpactPct: new Decimal(data.priceImpactPct).toFixed(),
      slippageBps: data.slippageBps,
      route: data.routePlan.map((r) => r.swapInfo.label).join(' -> '),
    };
  }

  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string,
  ): Promise<Buffer> {
    const data = await this.fetchWithRetry<JupiterSwapResponse>(
      `${this.apiUrl}/swap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey,
          wrapAndUnwrapSol: true,
          asLegacyTransaction: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      },
    );

    if (!data.swapTransaction) {
      throw new Error('Jupiter swap response missing swapTransaction field');
    }

    return Buffer.from(data.swapTransaction, 'base64');
  }

  async getRawQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<JupiterQuoteResponse> {
    const amountRaw = decimalToRaw(amount, inputMint === SOL_MINT ? 9 : 0);

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'true',
    });

    return this.fetchWithRetry<JupiterQuoteResponse>(
      `${this.apiUrl}/quote?${params.toString()}`,
      { method: 'GET' },
    );
  }

  async quoteBuy(tokenMint: string, amountSol: string, slippageBps: number): Promise<QuoteResult> {
    return this.getQuote(SOL_MINT, tokenMint, amountSol, slippageBps);
  }

  async quoteSell(tokenMint: string, amountToken: string, slippageBps: number): Promise<QuoteResult> {
    return this.getQuote(tokenMint, SOL_MINT, amountToken, slippageBps);
  }

  private async fetchWithRetry<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        if (response.status === 429) {
          lastError = new Error('Jupiter rate limited (429)');
          if (attempt < MAX_RETRIES) {
            await this.sleep(RETRY_BASE_MS * Math.pow(2, attempt));
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Jupiter API ${response.status}: ${body.slice(0, 200)}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Jupiter request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        const isRetryable =
          lastError.message.includes('rate limit') ||
          lastError.message.includes('timed out') ||
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('fetch failed');

        if (!isRetryable || attempt >= MAX_RETRIES) throw lastError;

        await this.sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error('Jupiter request failed');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function decimalToRaw(amount: string, decimals: number): bigint {
  const raw = new Decimal(amount)
    .times(new Decimal(10).pow(decimals))
    .toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (!raw.isFinite() || raw.isNegative()) {
    throw new Error(`Invalid quote amount: ${amount}`);
  }
  return BigInt(raw.toFixed(0));
}

function rawToDecimalString(raw: bigint, decimals: number): string {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed();
}
