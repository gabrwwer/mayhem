import { Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAMS } from '@mayhem/solana';
import { BotState } from './state';
import { ingestTransaction, ingestHolderObservation, ingestLiquidityObservation, getComputedMetrics } from './metrics';
import { readBotEnvFile, writeBotEnvUpdates, resolveBotEnvPath } from './env-file';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Whitelist of dashboard-editable config fields.
 *
 * `envKey` is the CANONICAL variable the bot's execution code actually
 * reads (see apps/bot/src/index.ts) — not a legacy/dashboard-only alias.
 * In particular STOP_LOSS_PCT / TRAILING_STOP_PCT (not the _PERCENT
 * variants) are what config.exit actually feeds into TradingConfig, so
 * those are the ones wired here; editing the _PERCENT aliases would
 * change what's *displayed* without changing bot behavior.
 */
type FieldType = 'number' | 'int';
interface ConfigField {
  envKey: string;
  type: FieldType;
  min: number;
  max: number;
}

const CONFIG_FIELDS: Record<string, ConfigField> = {
  maxPositionSol: { envKey: 'MAX_POSITION_SOL', type: 'number', min: 0, max: 1000 },
  maxOpenPositions: { envKey: 'MAX_OPEN_POSITIONS', type: 'int', min: 1, max: 100 },
  takeProfitPercent: { envKey: 'TAKE_PROFIT_PERCENT', type: 'number', min: 0, max: 10000 },
  stopLossPercent: { envKey: 'STOP_LOSS_PCT', type: 'number', min: 0, max: 100 },
  trailingStopPercent: { envKey: 'TRAILING_STOP_PCT', type: 'number', min: 0, max: 100 },
  maxHoldSeconds: { envKey: 'MAX_HOLD_SECONDS', type: 'int', min: 1, max: 604_800 },
  slippageBps: { envKey: 'SLIPPAGE_BPS', type: 'int', min: 0, max: 5000 },
  minLiquiditySol: { envKey: 'MIN_LIQUIDITY_SOL', type: 'number', min: 0, max: 100_000 },
  maxTopHolderPercent: { envKey: 'MAX_TOP_HOLDER_PERCENT', type: 'number', min: 1, max: 100 },
  minHolders: { envKey: 'MIN_HOLDERS', type: 'int', min: 0, max: 100_000 },
  maxDailyLossSol: { envKey: 'MAX_DAILY_LOSS_SOL', type: 'number', min: 0, max: 100_000 },
  maxExposureSol: { envKey: 'MAX_EXPOSURE_SOL', type: 'number', min: 0, max: 100_000 },
  maxDrawdownPct: { envKey: 'MAX_DRAWDOWN_PCT', type: 'number', min: 1, max: 100 },
  maxConsecutiveLosses: { envKey: 'MAX_CONSECUTIVE_LOSSES', type: 'int', min: 1, max: 1000 },
};

const CONFIG_DEFAULTS: Record<string, string> = {
  MAX_POSITION_SOL: '0.05',
  MAX_OPEN_POSITIONS: '3',
  TAKE_PROFIT_PERCENT: '20',
  STOP_LOSS_PCT: '10',
  TRAILING_STOP_PCT: '8',
  MAX_HOLD_SECONDS: '300',
  SLIPPAGE_BPS: '100',
  MIN_LIQUIDITY_SOL: '5',
  MAX_TOP_HOLDER_PERCENT: '20',
  MIN_HOLDERS: '10',
  MAX_DAILY_LOSS_SOL: '2',
  MAX_EXPOSURE_SOL: '0.3',
  MAX_DRAWDOWN_PCT: '25',
  MAX_CONSECUTIVE_LOSSES: '3',
};

let cachedBalance: { sol: number; tokens: Record<string, number>; fetchedAt: number } | null = null;
const BALANCE_CACHE_MS = 5_000;

async function fetchOnChainBalance(rpcUrl: string, publicKey: string): Promise<{ sol: number; tokens: Record<string, number> }> {
  const now = Date.now();
  if (cachedBalance && now - cachedBalance.fetchedAt < BALANCE_CACHE_MS) {
    return { sol: cachedBalance.sol, tokens: cachedBalance.tokens };
  }

  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const pubkey = new PublicKey(publicKey);
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // Query BOTH token programs from the shared constant. Hardcoding the
    // base58 here is what allowed a wrong program id to live in the
    // codebase (see @mayhem/solana/constants.ts), and querying only the
    // legacy program silently under-reports Token-2022 holdings — which
    // pump.fun mints are.
    const tokens: Record<string, number> = {};

    for (const programId of TOKEN_PROGRAMS) {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
        programId,
      });

      for (const account of tokenAccounts.value) {
        const parsed = account.account.data.parsed;
        const mint: string = parsed?.info?.mint;
        const amount: number = parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (typeof mint === 'string' && amount > 0) {
          tokens[mint] = (tokens[mint] ?? 0) + amount;
        }
      }
    }

    cachedBalance = { sol, tokens, fetchedAt: now };
    return { sol, tokens };
  } catch {
    return { sol: cachedBalance?.sol ?? 0, tokens: cachedBalance?.tokens ?? {} };
  }
}

export function createRoutes(state: BotState) {
  return {
    getStatus(_req: Request, res: Response) {
      res.json({
        status: state.status,
        dryRun: state.dryRun,
        tradingEnabled: state.tradingEnabled,
        emergencyStop: state.emergencyStop,
        startedAt: state.startedAt,
        openPositions: [...state.positions.values()].filter(p => p.status === 'open').length,
        totalTrades: state.trades.length,
      });
    },

    getTokens(_req: Request, res: Response) {
      const tokens = [...state.tokens.values()];
      const enriched = tokens.map((t: any) => {
        const mint = t.tokenMint ?? t.tokenMintAddress ?? t.mint ?? null;
        if (!mint) return t;
        try {
          const metrics = getComputedMetrics(mint);
          return { ...t, discoveryMetrics: metrics };
        } catch {
          return { ...t, discoveryMetrics: null };
        }
      });
      res.json(enriched);
    },

    clearTokens(_req: Request, res: Response) {
      const count = state.tokens.size;
      state.tokens.clear();
      state.emit('tokens_cleared', { at: new Date().toISOString(), count });
      res.json({ ok: true, cleared: count });
    },

    getLaunches(_req: Request, res: Response) {
      res.json(state.launches.slice(-100));
    },

    getPositions(_req: Request, res: Response) {
      const status = (_req.query['status'] as string) || 'all';
      // Read current bot .env for settings values (don't trust process.env)
      const fileEnv = readBotEnvFile();
      let positions = [...state.positions.values()];
      if (status !== 'all') {
        positions = positions.filter(p => p.status === status);
      }

      // Map to a stable, dashboard-friendly shape. Do not fabricate values;
      // expose what's present and mark unavailable fields explicitly.
      const mapped = positions.map((pRaw) => {
        const p = pRaw as Record<string, any>;
        const entryPrice = typeof p['entryPrice'] === 'number' ? p['entryPrice'] : null;
        const currentPrice = typeof p['currentPrice'] === 'number' ? p['currentPrice'] : null;
        const quantity = typeof p['quantity'] === 'number' ? p['quantity'] : null;
        const positionValueSol = currentPrice !== null && quantity !== null ? currentPrice * quantity : null;
        const unrealizedPnl = typeof p['unrealizedPnl'] === 'number' ? p['unrealizedPnl'] : null;
        const unrealizedPnlPercent = (entryPrice && currentPrice)
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : null;

        const statusState = (p['status'] === 'closed') ? 'CLOSED' : (p['status'] === 'exiting' ? 'EXIT_PENDING' : 'OPEN');

        // Trailing stop status
        const trailingEnabled = (readBotEnvFile()['TRAILING_STOP_PCT'] ?? CONFIG_DEFAULTS['TRAILING_STOP_PCT']) !== undefined;
        const trailingStopPriceRaw = typeof p['trailingStop'] === 'number' ? p['trailingStop'] : null;
        const trailingStopStatus = trailingStopPriceRaw === null
          ? (trailingEnabled ? 'PENDING' : 'UNAVAILABLE')
          : 'AVAILABLE';

        // Hard stop price derived from global stop loss percent when possible
        const stopPctRaw = parseFloat((readBotEnvFile()['STOP_LOSS_PCT'] ?? CONFIG_DEFAULTS['STOP_LOSS_PCT']) as string);
        const hardStopPrice = entryPrice !== null && Number.isFinite(stopPctRaw)
          ? entryPrice * (1 - stopPctRaw / 100)
          : null;

        const mayhemScore = typeof p['mayhemScore'] === 'number' ? p['mayhemScore'] : (typeof p['opportunityScore'] === 'number' ? p['opportunityScore'] : null);
        const mayhemScoreStatus = mayhemScore === null ? 'UNAVAILABLE' : 'AVAILABLE';

        return {
          modifySupported: false,
          partialCloseSupported: false,
          positionId: p['id'],
          tokenMint: p['tokenMint'] ?? null,
          entryPrice,
          currentPrice,
          quantity,
          positionValueSol,
          unrealizedPnl,
          unrealizedPnlPercent,
          exitState: statusState,
          exitReason: p['exitReason'] ?? null,
          peakPrice: typeof p['peakPrice'] === 'number' ? p['peakPrice'] : null,
          drawdownFromPeakPct: (typeof p['peakPrice'] === 'number' && typeof currentPrice === 'number')
            ? ((p['peakPrice'] - currentPrice) / p['peakPrice']) * 100
            : null,
          trailingStopPrice: trailingStopPriceRaw,
          trailingStopStatus,
          hardStopPrice,
          score: mayhemScore,
          scoreStatus: mayhemScoreStatus,
          // Settings (explicit about source)
          stopLoss: {
            value: Number(fileEnv['STOP_LOSS_PCT'] ?? CONFIG_DEFAULTS['STOP_LOSS_PCT']) || 0,
            unit: 'percent',
            source: 'global',
          },
          takeProfit: {
            value: Number(fileEnv['TAKE_PROFIT_PERCENT'] ?? CONFIG_DEFAULTS['TAKE_PROFIT_PERCENT']) || 0,
            enabled: Number(fileEnv['TAKE_PROFIT_PERCENT'] ?? CONFIG_DEFAULTS['TAKE_PROFIT_PERCENT']) > 0,
            source: 'global',
          },
          trailingStop: {
            enabled: (fileEnv['TRAILING_STOP_PCT'] ?? CONFIG_DEFAULTS['TRAILING_STOP_PCT']) !== undefined,
            value: Number(fileEnv['TRAILING_STOP_PCT'] ?? CONFIG_DEFAULTS['TRAILING_STOP_PCT']) || 0,
            unit: 'percent',
            source: 'global',
          },
          // Expose raw position for debugging (kept small)
          _raw: { status: p['status'] },
        };
      });

      res.json(mapped);
    },

    getTrades(_req: Request, res: Response) {
      const limit = parseInt((_req.query['limit'] as string) || '50', 10);
      res.json(state.trades.slice(-limit));
    },

    // Events stream for alerts and operator-facing events
    getEvents(req: Request, res: Response) {
      const limit = Math.min(Number(req.query['limit'] ?? 100), 1000);
      const since = req.query['since'] as string | undefined;
      const eventType = req.query['eventType'] as string | undefined;
      const severity = req.query['severity'] as string | undefined;
      const mint = req.query['mint'] as string | undefined;
      const positionId = req.query['positionId'] as string | undefined;

      let items = [...state.events];

      if (since) {
        items = items.filter((e) => (e as any)['timestamp'] > since || (e as any)['id'] > since);
      }
      if (eventType) items = items.filter((e) => (e as any)['eventType'] === eventType);
      if (severity) items = items.filter((e) => String((e as any)['severity']) === severity);
      if (mint) items = items.filter((e) => (e as any)['mint'] === mint || (e as any)['metadata']?.mint === mint);
      if (positionId) items = items.filter((e) => (e as any)['positionId'] === positionId || (e as any)['metadata']?.positionId === positionId);

      // Return newest first
      items = items.slice(-limit).reverse();

      res.json(items.map((e) => ({
        id: (e as any)['id'],
        timestamp: (e as any)['timestamp'],
        eventType: (e as any)['eventType'],
        severity: (e as any)['severity'],
        mint: (e as any)['mint'],
        positionId: (e as any)['positionId'],
        message: (e as any)['message'],
        metadata: (e as any)['metadata'],
      })));
    },

    async getBalance(_req: Request, res: Response) {
      const rpcUrl = process.env['SOLANA_RPC_URL'] as string | undefined;
      const walletFile = process.env['WALLET_FILE_PATH'] as string | undefined;
      const dryRun = (process.env['DRY_RUN'] as string | undefined)?.toLowerCase() !== 'false';

      if (dryRun || !rpcUrl || !walletFile) {
        res.json({
          sol: state.balance.sol,
          tokens: Object.fromEntries(state.balance.tokens),
        });
        return;
      }

      try {
        const fs = await import('fs');
        const crypto = await import('crypto');
        const { Keypair } = await import('@solana/web3.js');

        const password = process.env['WALLET_PASSWORD'] as string | undefined;
        if (!password) {
          res.json({ sol: 0, tokens: {} });
          return;
        }

        const payload = fs.readFileSync(walletFile!);
        const salt = payload.subarray(0, 32);
        const iv = payload.subarray(32, 44);
        const authTag = payload.subarray(44, 60);
        const encrypted = payload.subarray(60);
        const key = crypto.pbkdf2Sync(password, salt, 600_000, 32, 'sha512');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const keypair = Keypair.fromSecretKey(new Uint8Array(decrypted));
        const publicKey = keypair.publicKey.toBase58();

        const balance = await fetchOnChainBalance(rpcUrl!, publicKey);
        res.json(balance);
      } catch {
        res.json({ sol: 0, tokens: {} });
      }
    },

    getConfig(_req: Request, res: Response) {
      // Read fresh from the bot's actual .env file on every request (not
      // process.env, which was captured once at API boot and may not even
      // be the same file the bot process reads — see env-file.ts) so the
      // panel always reflects the latest saved values, including ones
      // saved via updateConfig below without requiring an API restart.
      let fileEnv: Record<string, string> = {};
      let readError: string | null = null;
      try {
        fileEnv = readBotEnvFile();
      } catch (err) {
        readError = err instanceof Error ? err.message : 'Failed to read bot .env file';
      }

      const values: Record<string, number> = {};
      for (const [dashboardKey, field] of Object.entries(CONFIG_FIELDS)) {
        // Both lookups are index accesses, so `noUncheckedIndexedAccess`
        // types them as possibly undefined. Defaulting to '' makes the
        // parse fail cleanly into the 0 fallback below rather than
        // parseInt(undefined) — which is NaN anyway, but only by accident.
        const raw = fileEnv[field.envKey] ?? CONFIG_DEFAULTS[field.envKey] ?? '';
        const parsed = field.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
        values[dashboardKey] = Number.isFinite(parsed) ? parsed : 0;
      }

      res.json({
        dryRun: state.dryRun,
        tradingEnabled: state.tradingEnabled,
        ...values,
        configSource: resolveBotEnvPath(),
        configReadError: readError,
      });
    },

    getExits(_req: Request, res: Response) {
      // Read fresh values from the bot .env so the dashboard shows the
      // operator's saved configuration rather than process.env captured at boot.
      const fileEnv = readBotEnvFile();

      const resolved = {
        hardStopLossPct: Number(fileEnv['STOP_LOSS_PCT'] ?? CONFIG_DEFAULTS['STOP_LOSS_PCT']) || 0,
        takeProfitPct: Number(fileEnv['TAKE_PROFIT_PERCENT'] ?? CONFIG_DEFAULTS['TAKE_PROFIT_PERCENT']) || 0,
        trailingStopEnabled: (fileEnv['TRAILING_STOP_PCT'] ?? CONFIG_DEFAULTS['TRAILING_STOP_PCT']) !== undefined,
        trailingStopPct: Number(fileEnv['TRAILING_STOP_PCT'] ?? CONFIG_DEFAULTS['TRAILING_STOP_PCT']) || 0,
        exitMomentumWindowMs: Number(fileEnv['EXIT_MOMENTUM_WINDOW_MS'] ?? '10000'),
        exitMomentumSampleIntervalMs: Number(fileEnv['EXIT_MOMENTUM_SAMPLE_INTERVAL_MS'] ?? '1000'),
        exitMomentumConfirmSamples: Number(fileEnv['EXIT_MOMENTUM_CONFIRM_SAMPLES'] ?? '3'),
        exitMinBuyPressure: Number(fileEnv['EXIT_MIN_BUY_PRESSURE'] ?? fileEnv['MIN_BUY_PRESSURE'] ?? '0.4'),
        exitMaxSellPressure: Number(fileEnv['EXIT_MAX_SELL_PRESSURE'] ?? '0.6'),
        exitMinNetFlowPct: Number(fileEnv['EXIT_MIN_NET_FLOW_PCT'] ?? '-5'),
        dryRun: state.dryRun,
        tradingEnabled: state.tradingEnabled,
      };

      res.json(resolved);
    },

    updateConfig(req: Request, res: Response) {
      // Defense in depth: the dashboard already disables Save while live,
      // but never trust a client-side-only gate for something that
      // changes real risk parameters.
      if (!state.dryRun) {
        res.status(409).json({
          error: 'Configuration can only be changed while the bot is in dry-run mode (DRY_RUN=true).',
        });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const errors: string[] = [];
      const updates: Record<string, string> = {};
      const changed: { field: string; envKey: string; from: string | undefined; to: string }[] = [];

      let currentEnv: Record<string, string>;
      try {
        currentEnv = readBotEnvFile();
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to read bot .env file',
        });
        return;
      }

      for (const [dashboardKey, field] of Object.entries(CONFIG_FIELDS)) {
        if (!Object.prototype.hasOwnProperty.call(body, dashboardKey)) continue;

        const raw = body[dashboardKey];
        const num = typeof raw === 'number' ? raw : Number(raw);

        if (!Number.isFinite(num)) {
          errors.push(`${dashboardKey}: must be a number`);
          continue;
        }
        if (field.type === 'int' && !Number.isInteger(num)) {
          errors.push(`${dashboardKey}: must be a whole number`);
          continue;
        }
        if (num < field.min || num > field.max) {
          errors.push(`${dashboardKey}: must be between ${field.min} and ${field.max}`);
          continue;
        }

        const stringValue = field.type === 'int' ? String(Math.trunc(num)) : String(num);
        updates[field.envKey] = stringValue;
        changed.push({
          field: dashboardKey,
          envKey: field.envKey,
          from: currentEnv[field.envKey],
          to: stringValue,
        });
      }

      if (errors.length > 0) {
        res.status(400).json({ error: 'Validation failed', details: errors });
        return;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No recognized config fields in request body' });
        return;
      }

      try {
        const { missing } = writeBotEnvUpdates(updates);
        if (missing.length > 0) {
          res.status(500).json({
            error: `The following keys were not found in the bot .env file and were not written: ${missing.join(', ')}`,
          });
          return;
        }
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to write bot .env file',
        });
        return;
      }

      // Audit trail: every config change, before/after, timestamped.
      state.emit('config_updated', {
        at: new Date().toISOString(),
        changes: changed,
      });

      res.json({
        ok: true,
        restartRequired: true,
        message: 'Saved to the bot\'s .env file. Restart the bot for these changes to take effect.',
        changed,
      });
    },

    getTelemetry(_req: Request, res: Response) {
      const t = state.telemetry;
      const totalTrades = t.winCount + t.lossCount;
      res.json({
        ...t,
        winRate: totalTrades > 0 ? (t.winCount / totalTrades * 100).toFixed(1) + '%' : 'N/A',
        avgDiscoveryLatencyMs: avg(t.discoveryLatencyMs),
        avgQuoteLatencyMs: avg(t.quoteLatencyMs),
        avgTxBuildTimeMs: avg(t.txBuildTimeMs),
        avgTxConfirmTimeMs: avg(t.txConfirmTimeMs),
      });
    },

    getRejections(_req: Request, res: Response) {
      const r = (state as any).rejections ?? [];
      res.json(r.slice(-200).reverse());
    },

    // Internal: accept discovered tokens (and later stage/enrichment
    // updates) pushed by the bot (dev only).
    //
    // This MERGES onto any existing record for the same tokenMint rather
    // than overwriting it, so a later partial update — e.g. just
    // {tokenMint, stage: 'GRADUATED', graduatedAt} from the bot's
    // bonding-curve poller — doesn't blow away the original discovery
    // fields (symbol, name, discoveredAt, etc.).
    postInternalTokens(req: Request, res: Response) {
      const body = req.body as any;
      if (!body || !body.tokenMint) {
        res.status(400).json({ error: 'tokenMint required' });
        return;
      }

      const key = body.tokenMint as string;
      const existing = state.tokens.get(key) as Record<string, unknown> | undefined;

      // `noPropertyAccessFromIndexSignature` forbids dot access on a
      // Record. A named accessor keeps the merge readable instead of
      // scattering `existing?.['field']` across twenty lines.
      const prev = (field: string): unknown => existing?.[field];

      const tokenObj: Record<string, unknown> = {
        tokenMint: key,
        symbol: body.symbol ?? body.tokenSymbol ?? prev('symbol') ?? 'UNKNOWN',
        name: body.name ?? body.tokenName ?? prev('name') ?? null,
        initialLiquidity: body.initialLiquidity ?? prev('initialLiquidity') ?? null,
        poolAddress: body.poolAddress ?? prev('poolAddress') ?? null,
        source: body.source ?? prev('source') ?? 'bot',
        // "DETECTED" is the only stage the bot can claim at first sight;
        // later posts (e.g. graduation) override it explicitly.
        stage: body.stage ?? prev('stage') ?? 'DETECTED',
        graduatedAt: body.graduatedAt ?? prev('graduatedAt') ?? null,
        discoveredAt: prev('discoveredAt') ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Enrichment fields (best-effort, populated by a later post from
        // the bot's enrichment pass — see apps/bot/src/enrichment.ts).
        // Never fabricated on the API side: absent unless the bot actually
        // sent a value, and merged so a partial enrichment update doesn't
        // wipe fields it didn't compute.
        price: body.price ?? prev('price') ?? null,
        liquidity: body.liquidity ?? prev('liquidity') ?? null,
        marketCap: body.marketCap ?? prev('marketCap') ?? null,
        // Denominated in USD, unlike marketCap which is in SOL. Carried as a
        // separate field rather than folded into one "market cap" — mixing the
        // two units in a single column is how a 40 SOL token reads as $40.
        usdMarketCap: body.usdMarketCap ?? prev('usdMarketCap') ?? null,
        totalSupply: body.totalSupply ?? prev('totalSupply') ?? null,
        volume24h: body.volume24h ?? prev('volume24h') ?? null,
        holders: body.holders ?? prev('holders') ?? null,
        topHolderPercent: body.topHolderPercent ?? prev('topHolderPercent') ?? null,
        riskScore: body.riskScore ?? prev('riskScore') ?? null,
        enrichmentNote: body.enrichmentNote ?? prev('enrichmentNote') ?? null,
        raw: body.raw ?? prev('raw') ?? body,
      };

      state.tokens.set(key, tokenObj);
      state.emit('token_discovered', tokenObj);
      res.json({ ok: true });
    },

    // Internal: ingest normalized flow/transaction/holder observations from
    // providers or the bot so the API can compute discovery metrics.
    postInternalFlow(req: Request, res: Response) {
      const body = req.body as any;
      if (!body || !body.mint || !body.type) {
        res.status(400).json({ error: 'mint and type required' });
        return;
      }

      const now = Date.now();

      try {
        // Accept canonical type names: 'transaction' | 'holder' | 'liquidity'
        if (body.type === 'tx' || body.type === 'transaction') {
          // required: side, volumeSol/amountSol, signature optional
          const side = (body.side === 'sell' || body.side === 'SELL') ? 'sell' : 'buy';
          const amountSol = Number(body.volumeSol ?? body.amountSol ?? body.volume ?? NaN);
          if (!Number.isFinite(amountSol)) {
            res.status(400).json({ error: 'numeric volumeSol/amountSol required' });
            return;
          }
          ingestTransaction({
            ts: body.ts ?? now,
            mint: body.mint,
            side,
            amountSol,
            buyer: body.buyer ?? null,
            seller: body.seller ?? null,
            signature: typeof body.signature === 'string' ? body.signature : null,
          });
          res.json({ ok: true });
          return;
        }

        if (body.type === 'holder') {
          const count = Number(body.count);
          if (!Number.isFinite(count)) {
            res.status(400).json({ error: 'numeric count required' });
            return;
          }
          ingestHolderObservation(body.mint, body.ts ?? now, count);
          res.json({ ok: true });
          return;
        }

        if (body.type === 'liquidity' || body.type === 'curve') {
          const liquiditySol = typeof body.liquiditySol === 'number' ? body.liquiditySol : (typeof body.liquidity === 'number' ? body.liquidity : null);
          const curveReserveSol = typeof body.curveReserveSol === 'number' ? body.curveReserveSol : null;
          const curveProgressPct = typeof body.curveProgressPct === 'number' ? body.curveProgressPct : null;
          ingestLiquidityObservation(body.mint, body.ts ?? now, liquiditySol, curveReserveSol, curveProgressPct, body.dex ?? null);
          res.json({ ok: true });
          return;
        }

        res.status(400).json({ error: 'unsupported type' });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    /**
     * Internal: authoritative snapshot of the bot's OPEN positions.
     *
     * Until this existed the API's position map was written by exactly one
     * function — closePosition — so it started empty and stayed empty. The
     * dashboard's Positions page, P&L band and exposure figures therefore read
     * zero during a perfectly healthy trading session, which is worse than
     * showing nothing: it looks like a confident report that nothing is open.
     *
     * A full snapshot rather than incremental deltas, deliberately. Deltas
     * require every open/close to be delivered exactly once; a single dropped
     * message leaves a phantom position on the operator's screen forever. A
     * snapshot is self-healing — the next push corrects any drift.
     *
     * Closed positions already recorded are preserved: the snapshot is
     * authoritative for what is OPEN, not for history.
     */
    postInternalPositions(req: Request, res: Response) {
      const body = req.body as { positions?: unknown };

      if (!Array.isArray(body?.positions)) {
        res.status(400).json({ error: 'positions array required' });
        return;
      }

      // Drop the previous open set before applying the new one, so a position
      // the bot has since exited does not linger as open.
      for (const [id, position] of state.positions) {
        if ((position as { status?: string }).status === 'open') {
          state.positions.delete(id);
        }
      }

      let accepted = 0;

      for (const raw of body.positions) {
        if (typeof raw !== 'object' || raw === null) continue;

        const record = raw as Record<string, unknown>;
        const id = record['id'];
        if (typeof id !== 'string' || id === '') continue;

        state.positions.set(id, { ...record, status: 'open' });
        accepted += 1;
      }

      state.emit('positions_synced', {
        at: new Date().toISOString(),
        count: accepted,
      });

      res.json({ ok: true, accepted });
    },

    /**
     * Internal: wallet balance reported by the bot.
     *
     * In dry run the API cannot derive this — there is no on-chain wallet to
     * read, and `state.balance.sol` was initialised to 0 and never written,
     * which is why SIM_INITIAL_SOL appeared to have no effect in the UI.
     */
    postInternalBalance(req: Request, res: Response) {
      const body = req.body as { sol?: unknown; tokens?: unknown };
      const sol = typeof body?.sol === 'number' && Number.isFinite(body.sol) ? body.sol : null;

      if (sol === null) {
        res.status(400).json({ error: 'numeric sol balance required' });
        return;
      }

      state.balance.sol = sol;

      if (typeof body.tokens === 'object' && body.tokens !== null) {
        state.balance.tokens.clear();
        for (const [mint, amount] of Object.entries(body.tokens as Record<string, unknown>)) {
          if (typeof amount === 'number' && Number.isFinite(amount)) {
            state.balance.tokens.set(mint, amount);
          }
        }
      }

      res.json({ ok: true });
    },

    // Internal: telemetry / rejection events forwarded by the bot (dev only)
    postInternalTelemetry(req: Request, res: Response) {
      const body = req.body as any;
      if (!body || !body.event) {
        res.status(400).json({ error: 'event required' });
        return;
      }

      if (!(state as any).rejections) (state as any).rejections = [];
      (state as any).rejections.push({ receivedAt: new Date().toISOString(), ...body });
      state.emit('telemetry', body);
      res.json({ ok: true });
    },

    start(_req: Request, res: Response) {
      if (state.emergencyStop) {
        res.status(400).json({ error: 'Emergency stop is active. Clear it before starting.' });
        return;
      }
      state.start();
      res.json({ status: state.status });
    },

    pause(_req: Request, res: Response) {
      state.pause();
      res.json({ status: state.status });
    },

    emergencyStop(_req: Request, res: Response) {
      state.triggerEmergencyStop();
      res.json({ status: state.status, message: 'Emergency stop activated. No new positions will be opened.' });
    },

    // Expose discoveries under a dashboard-friendly path
    getDiscoveries(_req: Request, res: Response) {
      const tokens = [...state.tokens.values()];
      const enriched = tokens.map((t: any) => {
        const mint = t.tokenMint ?? t.tokenMintAddress ?? t.mint ?? null;
        if (!mint) return t;
        try {
          const metrics = getComputedMetrics(mint);
          return { ...t, discoveryMetrics: metrics };
        } catch {
          return { ...t, discoveryMetrics: null };
        }
      });
      res.json(enriched);
    },

    // Partial close: either `quantity` OR `percentage` must be provided.
    partialClose(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;
      if (!id) return res.status(400).json({ error: 'Position id is required' });
      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) return res.status(404).json({ error: 'Position not found' });
      if (position['status'] === 'closed') return res.status(409).json({ error: 'Position already closed' });

      const body = req.body as any;
      const hasQty = typeof body?.quantity === 'number' && Number.isFinite(body.quantity);
      const hasPct = typeof body?.percentage === 'number' && Number.isFinite(body.percentage);
      if ((hasQty && hasPct) || (!hasQty && !hasPct)) {
        return res.status(400).json({ error: 'Provide either quantity or percentage (but not both)' });
      }

      // Simulate in DRY_RUN; otherwise emit an execution request for the engine
      if (state.dryRun) {
        const qty = hasQty ? (body as any).quantity : Math.floor(((position as any).quantity ?? 0) * (body.percentage / 100));
        const remaining = ((position as any).quantity ?? 0) - qty;
        (position as any).quantity = remaining;
        if (remaining <= 0) {
          (position as any).status = 'closed';
          (position as any).closedAt = new Date().toISOString();
          state.emit('position_closed', position);
        } else {
          state.emit('position_partial_close', { id, closedQuantity: qty, remaining });
        }
        state.positions.set(id, position);
        return res.json({ ok: true, position });
      }

      state.emit('execution_request', { type: 'partial_close', id, body });
      return res.status(202).json({ accepted: true });
    },

    modifyPosition(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;
      if (!id) return res.status(400).json({ error: 'Position id is required' });
      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) return res.status(404).json({ error: 'Position not found' });

      const body = req.body as any;
      // Strict validation: allow changing `stopLoss`, `takeProfit`, `trailingStop` only
      const allowed = ['stopLoss', 'takeProfit', 'trailingStop'];
      const updates: Record<string, any> = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(body, k)) updates[k] = body[k];
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No mutable fields provided' });

      if (state.dryRun) {
        Object.assign(position, updates);
        state.positions.set(id, position);
        state.emit('position_modified', { id, updates });
        return res.json({ ok: true, position });
      }

      state.emit('execution_request', { type: 'modify', id, updates });
      return res.status(202).json({ accepted: true });
    },

    stopLoss(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;
      if (!id) return res.status(400).json({ error: 'Position id is required' });
      const body = req.body as any;
      if (typeof body?.price !== 'number' || !Number.isFinite(body.price)) return res.status(400).json({ error: 'numeric price required' });

      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) return res.status(404).json({ error: 'Position not found' });

      if (state.dryRun) {
        (position as any).stopLoss = body.price;
        state.positions.set(id, position);
        state.emit('stop_loss_set', { id, price: body.price });
        return res.json({ ok: true, position });
      }

      state.emit('execution_request', { type: 'stop_loss', id, price: body.price });
      return res.status(202).json({ accepted: true });
    },

    trailingStop(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;
      if (!id) return res.status(400).json({ error: 'Position id is required' });
      const body = req.body as any;
      if (typeof body?.pct !== 'number' || !Number.isFinite(body.pct)) return res.status(400).json({ error: 'numeric pct required' });

      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) return res.status(404).json({ error: 'Position not found' });

      if (state.dryRun) {
        (position as any).trailingStop = body.pct;
        state.positions.set(id, position);
        state.emit('trailing_stop_set', { id, pct: body.pct });
        return res.json({ ok: true, position });
      }

      state.emit('execution_request', { type: 'trailing_stop', id, pct: body.pct });
      return res.status(202).json({ accepted: true });
    },

    takeProfit(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;
      if (!id) return res.status(400).json({ error: 'Position id is required' });
      const body = req.body as any;
      if (typeof body?.price !== 'number' || !Number.isFinite(body.price)) return res.status(400).json({ error: 'numeric price required' });

      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) return res.status(404).json({ error: 'Position not found' });

      if (state.dryRun) {
        (position as any).takeProfit = body.price;
        state.positions.set(id, position);
        state.emit('take_profit_set', { id, price: body.price });
        return res.json({ ok: true, position });
      }

      state.emit('execution_request', { type: 'take_profit', id, price: body.price });
      return res.status(202).json({ accepted: true });
    },

    // Portfolio summary
    getPortfolio(_req: Request, res: Response) {
      const timestamp = new Date().toISOString();
      const walletBalanceSol = typeof state.balance.sol === 'number' ? state.balance.sol : null;
      // token holdings valuation requires token prices from discoveries
      let tokenValueSol: number | null = 0;
      const missingValuation: string[] = [];
      for (const [mint, amount] of state.balance.tokens.entries()) {
        const token = state.tokens.get(mint) as Record<string, any> | undefined;
        const price = (token as any)?.price ?? null;
        if (price === null || typeof price !== 'number') {
          missingValuation.push(mint);
        } else {
          tokenValueSol = (tokenValueSol ?? 0) + price * amount;
        }
      }

      if (missingValuation.length > 0) tokenValueSol = null;

      const totalPortfolioValueSol = (walletBalanceSol === null || tokenValueSol === null) ? null : (walletBalanceSol + (tokenValueSol ?? 0));

      // Realized/unrealized from positions if available
      let realizedPnlSol: number | null = 0;
      let unrealizedPnlSol: number | null = 0;
      for (const p of state.positions.values()) {
        if (typeof p['realizedPnl'] === 'number') realizedPnlSol = (realizedPnlSol ?? 0) + p['realizedPnl'];
        if (typeof p['unrealizedPnl'] === 'number') unrealizedPnlSol = (unrealizedPnlSol ?? 0) + p['unrealizedPnl'];
      }

      if (realizedPnlSol === 0) realizedPnlSol = null;
      if (unrealizedPnlSol === 0) unrealizedPnlSol = null;

      res.json({
        walletBalanceSol,
        cashBalanceSol: walletBalanceSol,
        tokenValueSol,
        totalPortfolioValueSol,
        realizedPnlSol,
        unrealizedPnlSol,
        totalPnlSol: (realizedPnlSol === null && unrealizedPnlSol === null) ? null : ((realizedPnlSol ?? 0) + (unrealizedPnlSol ?? 0)),
        totalPnlPct: null,
        openPositions: [...state.positions.values()].filter((p) => p.status === 'open').length,
        timestamp,
      });
    },

    // Equity snapshots (instantaneous single-point snapshot when no history)
    getEquity(_req: Request, res: Response) {
      const timestamp = new Date().toISOString();
      const walletBalanceSol = typeof state.balance.sol === 'number' ? state.balance.sol : null;
      if (walletBalanceSol === null) {
        res.json({ status: 'DATA_INSUFFICIENT', snapshots: [], missing: ['wallet'] });
        return;
      }
      // compute token value if possible
      let tokenValueSol: number | null = 0;
      const missing: string[] = [];
      for (const [mint, amount] of state.balance.tokens.entries()) {
        const token = state.tokens.get(mint) as Record<string, any> | undefined;
        const price = (token as any)?.price ?? null;
        if (price === null || typeof price !== 'number') missing.push(mint);
        else tokenValueSol = (tokenValueSol ?? 0) + price * amount;
      }
      if (missing.length > 0) {
        res.json({ status: 'DATA_INSUFFICIENT', snapshots: [], missing });
        return;
      }

      const total = walletBalanceSol + (tokenValueSol ?? 0);
      res.json({ status: 'AVAILABLE', snapshots: [{ timestamp, totalPortfolioValueSol: total }] });
    },

    // Risk summary: configured limits + current measurements
    getRisk(_req: Request, res: Response) {
      const fileEnv = readBotEnvFile();

      const configured: Record<string, any> = {
        dailyLossLimit: Number(fileEnv['MAX_DAILY_LOSS_SOL'] ?? CONFIG_DEFAULTS['MAX_DAILY_LOSS_SOL']),
        maxDrawdown: Number(fileEnv['MAX_DRAWDOWN_PCT'] ?? CONFIG_DEFAULTS['MAX_DRAWDOWN_PCT']),
        maxConsecutiveLosses: Number(fileEnv['MAX_CONSECUTIVE_LOSSES'] ?? CONFIG_DEFAULTS['MAX_CONSECUTIVE_LOSSES']),
        maxPositionSol: Number(fileEnv['MAX_POSITION_SOL'] ?? CONFIG_DEFAULTS['MAX_POSITION_SOL']),
        maxOpenPositions: Number(fileEnv['MAX_OPEN_POSITIONS'] ?? CONFIG_DEFAULTS['MAX_OPEN_POSITIONS']),
        maxEntryPriceImpactBps: Number(fileEnv['SLIPPAGE_BPS'] ?? CONFIG_DEFAULTS['SLIPPAGE_BPS']),
        maxSlippagePct: Number(fileEnv['SLIPPAGE_BPS'] ?? CONFIG_DEFAULTS['SLIPPAGE_BPS']) / 100,
      };

      const current: Record<string, any> = {
        dailyLoss: { value: state.telemetry.totalPnl ?? null, status: state.telemetry.totalPnl === 0 ? 'UNAVAILABLE' : 'AVAILABLE' },
        drawdown: { value: state.telemetry.maxDrawdown ?? null, status: state.telemetry.maxDrawdown === 0 ? 'UNAVAILABLE' : 'AVAILABLE' },
        consecutiveLosses: { value: state.telemetry.lossCount ?? null, status: state.telemetry.lossCount === 0 ? 'UNAVAILABLE' : 'AVAILABLE' },
        realizedSlippage: { value: state.telemetry.totalSlippage ?? null, status: state.telemetry.totalSlippage === 0 ? 'UNAVAILABLE' : 'AVAILABLE' },
        openPositions: { value: [...state.positions.values()].filter((p) => p.status === 'open').length, status: 'AVAILABLE' },
        exposureSol: { value: null, status: 'UNAVAILABLE' },
        circuitBreakerState: { value: state.emergencyStop ? 'TRIPPED' : 'OK', status: 'AVAILABLE' },
        riskState: { value: state.status, status: 'AVAILABLE' },
      };

      res.json({ configured, current });
    },

    async closePosition(req: Request, res: Response) {
      const id = req.params['id'] as string | undefined;

      if (!id) {
        res.status(400).json({ error: 'Position id is required' });
        return;
      }

      const position = state.positions.get(id) as Record<string, any> | undefined;
      if (!position) {
        res.status(404).json({ error: 'Position not found' });
        return;
      }

      if (position['status'] === 'closed') {
        res.status(409).json({ error: 'Position already closed' });
        return;
      }

      // Mark exiting and emit lifecycle events. Do NOT remove the position
      // until the exit is confirmed.
      position['status'] = 'exiting';
      state.positions.set(id, position);
      state.emit('position_exit_state', { id, state: 'EXIT_PENDING', at: new Date().toISOString() });

      try {
        // Simulated quote/execution for DRY_RUN. Use available market numbers
        // from the position rather than fabricating external data.
        const entryPrice = typeof position['entryPrice'] === 'number' ? position['entryPrice'] : null;
        const currentPrice = typeof position['currentPrice'] === 'number' ? position['currentPrice'] : entryPrice;
        const quantity = typeof position['quantity'] === 'number' ? position['quantity'] : 0;

        const exitPrice = currentPrice ?? entryPrice ?? 0;
        const exitQuantity = quantity;

        state.emit('position_exit_state', { id, state: 'EXIT_QUOTED', quote: { price: exitPrice }, at: new Date().toISOString() });

        // In a real environment we would build/send a tx. In DRY_RUN we
        // simulate an immediate successful fill at the quoted price.
        const grossProceeds = exitPrice * exitQuantity;
        const fees = 0;
        const netPnl = (typeof position['originalEntryNotional'] === 'number')
          ? grossProceeds - position['originalEntryNotional']
          : null;
        const netPnlPercent = (netPnl !== null && typeof position['originalEntryNotional'] === 'number' && position['originalEntryNotional'] > 0)
          ? (netPnl / position['originalEntryNotional']) * 100
          : null;

        // Confirmed
        position['status'] = 'closed';
        position['exitReason'] = 'manual_close';
        position['closedAt'] = new Date().toISOString();
        position['exitPrice'] = exitPrice;
        position['exitQuantity'] = exitQuantity;
        position['grossProceeds'] = grossProceeds;
        position['fees'] = fees;
        position['netPnl'] = netPnl;
        position['netPnlPercent'] = netPnlPercent;

        state.positions.set(id, position);
        state.emit('position_exit_state', { id, state: 'EXIT_CONFIRMED', at: new Date().toISOString() });
        state.emit('position_closed', position);

        res.json({
          positionId: id,
          status: 'closed',
          exitPrice,
          exitQuantity,
          grossProceeds,
          fees,
          netPnl,
          netPnlPercent,
          exitReason: position['exitReason'],
          closedAt: position['closedAt'],
        });
      } catch (err) {
        // Roll back to open on failure.
        position['status'] = 'open';
        state.positions.set(id, position);
        state.emit('position_exit_state', { id, state: 'EXIT_FAILED', error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
        res.status(500).json({ error: 'Failed to close position', details: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}