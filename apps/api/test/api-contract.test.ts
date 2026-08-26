import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Request,
  Response,
  NextFunction,
} from 'express';

import { BotState } from '../src/state';
import { createRoutes } from '../src/routes';

type CallableHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>;

async function callHandler<T = unknown>(
  handler: CallableHandler,
  request: Partial<Request>,
): Promise<{ status: number; body: T }> {
  return new Promise((resolve) => {
    let statusCode = 200;

    const response = {
      status(code: number) {
        statusCode = code;
        return response;
      },
      json(payload: T) {
        resolve({ status: statusCode, body: payload });
        return response;
      },
    };

    handler(request as Request, response as unknown as Response, () => undefined);
  });
}

describe('API contract (basic)', () => {
  let state: BotState;
  let routes: ReturnType<typeof createRoutes>;

  beforeEach(() => {
    state = new BotState();
    routes = createRoutes(state) as any;
  });

  it('GET /api/events returns array', async () => {
    const result = await callHandler<unknown>(routes.getEvents, { query: {} });

    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
  });

  it('GET /api/discoveries returns tokens array', async () => {
    const result = await callHandler(routes.getDiscoveries, { query: {} });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
  });

  it('GET /api/positions returns array', async () => {
    const result = await callHandler(routes.getPositions, { query: {} });
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
  });

  it('POST /api/positions/:id/close simulates close in dry run', async () => {
    state.positions.set('p1', { id: 'p1', quantity: 2, entryPrice: 1, originalEntryNotional: 2, status: 'open' });
    const result = await callHandler<{ status: string }>(
      routes.closePosition,
      { params: { id: 'p1' } },
    );

    expect(result.body.status).toBe('closed');
  });

  it('POST /api/positions/:id/partial-close validates input', async () => {
    state.positions.set('p2', { id: 'p2', quantity: 10, status: 'open' });
    const bad = await callHandler(routes.partialClose, { params: { id: 'p2' }, body: {} });
    expect(bad.status).toBe(400);

    const ok = await callHandler<{ position: { quantity: number } }>(
      routes.partialClose,
      { params: { id: 'p2' }, body: { quantity: 4 } },
    );

    expect(ok.body.position.quantity).toBe(6);
  });

  it('GET /api/portfolio returns DATA_INSUFFICIENT when valuation missing', async () => {
    // mark balance as unavailable
    (state as any).balance.sol = null;
    const result = await callHandler<{ walletBalanceSol: number | null }>(routes.getPortfolio, {});
    expect(result.status).toBe(200);
    // walletBalanceSol should be null
    expect(result.body.walletBalanceSol).toBeNull();
  });

  it('GET /api/equity reports DATA_INSUFFICIENT when missing assets', async () => {
    (state as any).balance.sol = null;
    const result = await callHandler<{ status: string }>(routes.getEquity, {});
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('DATA_INSUFFICIENT');
  });

  it('GET /api/risk returns configured and current fields', async () => {
    const result = await callHandler<{ configured: unknown; current: unknown }>(routes.getRisk, {});
    expect(result.status).toBe(200);
    expect(result.body.configured).toBeDefined();
    expect(result.body.current).toBeDefined();
  });
});
