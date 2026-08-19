
import { QuoteResult } from '@mayhem/solana';

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
    amount: number,
    slippageBps: number,
  ): Promise<QuoteResult> {
    const amountLamports = inputMint === SOL_MINT
      ? Math.floor(amount * 1_000_000_000)
      : Math.floor(amount);

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountLamports.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'true',
    });

    const data = await this.fetchWithRetry<JupiterQuoteResponse>(
      `${this.apiUrl}/quote?${params}`,
      { method: 'GET' },
    );

    const inAmount = parseInt(data.inAmount, 10);
    const outAmount = parseInt(data.outAmount, 10);

    if (isNaN(inAmount) || isNaN(outAmount) || outAmount <= 0) {
      throw new Error(`Jupiter returned invalid amounts: in=${data.inAmount} out=${data.outAmount}`);
    }

    const inputSol = inputMint === SOL_MINT;
    const inHuman = inputSol ? inAmount / 1e9 : inAmount;
    const outHuman = inputSol ? outAmount : outAmount / 1e9;
    const price = inputSol ? inHuman / outHuman : outHuman / inHuman;

    return {
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inputAmount: inHuman,
      outputAmount: outHuman,
      pricePerToken: price,
      priceImpactPct: parseFloat(data.priceImpactPct),
      slippageBps: data.slippageBps,
      route: data.routePlan?.map(r => r.swapInfo.label).join(' â†’ ') ?? 'jupiter',
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
    amount: number,
    slippageBps: number,
  ): Promise<JupiterQuoteResponse> {
    const amountLamports = inputMint === SOL_MINT
      ? Math.floor(amount * 1_000_000_000)
      : Math.floor(amount);

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountLamports.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'true',
    });

    return this.fetchWithRetry<JupiterQuoteResponse>(
      `${this.apiUrl}/quote?${params}`,
      { method: 'GET' },
    );
  }

  async quoteBuy(tokenMint: string, amountSol: number, slippageBps: number): Promise<QuoteResult> {
    return this.getQuote(SOL_MINT, tokenMint, amountSol, slippageBps);
  }

  async quoteSell(tokenMint: string, amountToken: number, slippageBps: number): Promise<QuoteResult> {
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