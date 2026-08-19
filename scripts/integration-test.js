const crypto = require('crypto');
const fetch = globalThis.fetch || require('node-fetch');

const SECRET = 'internalsecret';
const API = 'http://127.0.0.1:3001';
const AUTH_TOKEN = 'testtoken';

function sign(body) {
  const ts = Date.now();
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  return { ts, raw, sig };
}

async function postInternal(path, body) {
  const { ts, raw, sig } = sign(body);
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mayhem-timestamp': String(ts),
      'x-mayhem-signature': sig,
    },
    body: raw,
  });
  const txt = await res.text();
  return { status: res.status, text: txt };
}

async function getApi(path) {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const txt = await res.text();
  return { status: res.status, text: txt };
}

(async () => {
  try {
    const mint = 'DummyMint111pump';
    const txBody = {
      type: 'transaction',
      mint,
      ts: Date.now(),
      signature: 'SIG1',
      side: 'buy',
      volumeSol: 0.5,
      buyer: 'Wallet1',
      price: 0.01,
      source: 'solana-onchain',
    };

    console.log('POST internal/flow (transaction) #1');
    console.log(await postInternal('/internal/flow', txBody));

    console.log('POST internal/flow (transaction) #2 (duplicate)');
    console.log(await postInternal('/internal/flow', txBody));

    console.log('POST internal/flow (holder)');
    console.log(await postInternal('/internal/flow', { type: 'holder', mint, ts: Date.now(), count: 42 }));

    console.log('POST internal/flow (liquidity)');
    console.log(await postInternal('/internal/flow', { type: 'liquidity', mint, ts: Date.now(), signature: 'SIG_LIQ1', liquiditySol: 5, curveReserveSol: 2, dex: 'raydium' }));

    console.log('POST internal/tokens (discovery)');
    const token = { tokenMint: mint, source: 'test' };
    console.log(await postInternal('/internal/tokens', token));

    console.log('GET /api/status');
    console.log(await getApi('/api/status'));

    console.log('GET /api/positions');
    console.log(await getApi('/api/positions'));

    console.log('GET /api/tokens');
    const tokens = await getApi('/api/tokens');
    console.log(tokens.status);
    try { console.log(JSON.stringify(JSON.parse(tokens.text), null, 2)); } catch(e){ console.log(tokens.text); }

  } catch (err) {
    console.error('ERROR', err);
    process.exit(1);
  }
})();
