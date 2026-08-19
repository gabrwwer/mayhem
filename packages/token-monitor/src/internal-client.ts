import { createHmac } from 'crypto';

export function signInternalPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export type InternalObservation = Record<string, unknown>;

/**
 * Post a signed observation to the API `/internal/flow` endpoint.
 * Best-effort: never throws, never delays the caller.
 */
export async function postInternalFlow(obs: InternalObservation): Promise<void> {
  try {
    const apiUrl = process.env['API_URL'];
    if (!apiUrl) return;

    const base = (apiUrl as string).replace(/\/+$/, '');
    const url = `${base}/internal/flow`;
    const raw = JSON.stringify(obs);
    const ts = Date.now();
    const secret = process.env['INTERNAL_API_SECRET'] ?? '';
    if (!secret) return;

    const signature = signInternalPayload(secret, ts, raw);

    const start = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mayhem-timestamp': String(ts),
        'x-mayhem-signature': signature,
      },
      body: raw,
    });

    const latency = Date.now() - start;

    // Read body for diagnostics (do not log secrets)
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {}

    // Whether authentication headers were included (boolean only)
    const authHeadersPresent = Boolean(secret && signature);

    try {
      console.log(
        JSON.stringify({
          event: 'FLOW_POST_RESPONSE',
          timestamp: new Date().toISOString(),
          requestUrl: url,
          requestPath: '/internal/flow',
          mint: obs['mint'] ?? null,
          txSignature: obs['signature'] ?? null,
          authHeadersPresent,
          status: res.status,
          statusText: res.statusText,
          responseBody: bodyText,
          latencyMs: latency,
        }),
      );
    } catch {}

    if (res.ok) {
      try {
        console.log(JSON.stringify({ event: 'FLOW_POST_ACCEPTED', mint: obs['mint'] ?? null, type: obs['type'] ?? null, signature: obs['signature'] ?? null, status: res.status, latencyMs: latency }));
      } catch {}
    } else {
      try {
        console.log(JSON.stringify({ event: 'FLOW_POST_REJECTED', mint: obs['mint'] ?? null, type: obs['type'] ?? null, signature: obs['signature'] ?? null, status: res.status, latencyMs: latency }));
      } catch {}
    }
  } catch (err) {
    try {
      console.log(
        JSON.stringify({
          event: 'FLOW_POST_ERROR',
          timestamp: new Date().toISOString(),
          requestUrl: process.env['API_URL'] ? `${(process.env['API_URL'] as string).replace(/\/+$/, '')}/internal/flow` : null,
          mint: obs['mint'] ?? null,
          txSignature: obs['signature'] ?? null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch {}
  }
}
