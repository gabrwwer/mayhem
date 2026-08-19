import { createHmac } from 'crypto';
export function signInternalPayload(secret, timestamp, rawBody) {
    return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
/**
 * Post a signed observation to the API `/internal/flow` endpoint.
 * Best-effort: never throws, never delays the caller.
 */
export async function postInternalFlow(obs) {
    try {
        const apiUrl = process.env['API_URL'];
        if (!apiUrl)
            return;
        const base = apiUrl.replace(/\/+$/, '');
        const url = `${base}/internal/flow`;
        const raw = JSON.stringify(obs);
        const ts = Date.now();
        const secret = process.env['INTERNAL_API_SECRET'] ?? '';
        if (!secret)
            return;
        const signature = signInternalPayload(secret, ts, raw);
        const start = Date.now();
        // Use global fetch if available. Best-effort: do not await to block callers
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
        if (res.ok) {
            try {
                console.log(JSON.stringify({ event: 'FLOW_POST_ACCEPTED', mint: obs.mint ?? null, type: obs.type ?? null, signature: obs.signature ?? null, status: res.status, latencyMs: latency }));
            }
            catch { }
        }
        else {
            try {
                console.log(JSON.stringify({ event: 'FLOW_POST_REJECTED', mint: obs.mint ?? null, type: obs.type ?? null, signature: obs.signature ?? null, status: res.status, latencyMs: latency }));
            }
            catch { }
        }
    }
    catch (err) {
        try {
            console.log(JSON.stringify({ event: 'FLOW_POST_FAILED', mint: obs.mint ?? null, type: obs.type ?? null, signature: obs.signature ?? null, error: err instanceof Error ? err.message : String(err) }));
        }
        catch { }
    }
}
//# sourceMappingURL=index.js.map