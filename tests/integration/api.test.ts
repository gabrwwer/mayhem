
import express from 'express';
import { createRoutes } from '../../apps/api/src/routes';
import { BotState } from '../../apps/api/src/state';

function createTestApp(state: BotState) {
  const app = express();
  app.use(express.json());
  const routes = createRoutes(state);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/status', routes.getStatus);
  app.get('/api/positions', routes.getPositions);
  app.get('/api/trades', routes.getTrades);
  app.get('/api/balance', routes.getBalance);
  app.get('/api/config', routes.getConfig);
  app.get('/api/telemetry', routes.getTelemetry);
  app.post('/api/start', routes.start);
  app.post('/api/pause', routes.pause);
  app.post('/api/emergency-stop', routes.emergencyStop);
  app.post('/api/positions/:id/close', routes.closePosition);
  return app;
}

async function request(app: any, method: string, path: string) {
  const http = await import('http');
  return new Promise<{ status: number; body: any }>((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.request({ hostname: 'localhost', port, path, method }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode || 0, body: JSON.parse(data || '{}') });
        });
      });
      req.end();
    });
  });
}

describe('API Integration', () => {
  let state: BotState;
  let app: any;

  beforeEach(() => {
    state = new BotState();
    app = createTestApp(state);
  });

  test('GET /health returns 200', async () => {
    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /api/status returns bot status', async () => {
    const res = await request(app, 'GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('STOPPED');
    expect(res.body.dryRun).toBe(true);
    expect(res.body.tradingEnabled).toBe(false);
  });

  test('GET /api/positions returns empty array', async () => {
    const res = await request(app, 'GET', '/api/positions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/trades returns empty array', async () => {
    const res = await request(app, 'GET', '/api/trades');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/balance returns balance', async () => {
    const res = await request(app, 'GET', '/api/balance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sol');
  });

  test('GET /api/config returns configuration', async () => {
    const res = await request(app, 'GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.tradingEnabled).toBe(false);
  });

  test('POST /api/start changes status', async () => {
    const res = await request(app, 'POST', '/api/start');
    expect(res.status).toBe(200);
    expect(state.status).toBe('DRY_RUN');
  });

  test('POST /api/pause changes status', async () => {
    state.start();
    const res = await request(app, 'POST', '/api/pause');
    expect(res.status).toBe(200);
    expect(state.status).toBe('PAUSED');
  });

  test('POST /api/emergency-stop activates emergency stop', async () => {
    const res = await request(app, 'POST', '/api/emergency-stop');
    expect(res.status).toBe(200);
    expect(state.emergencyStop).toBe(true);
    expect(state.status).toBe('EMERGENCY_STOP');
  });

  test('POST /api/start fails during emergency stop', async () => {
    state.triggerEmergencyStop();
    const res = await request(app, 'POST', '/api/start');
    expect(res.status).toBe(400);
  });

  test('GET /api/telemetry returns telemetry data', async () => {
    const res = await request(app, 'GET', '/api/telemetry');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('winRate');
    expect(res.body).toHaveProperty('totalPnl');
  });
});