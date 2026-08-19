const crypto = require('crypto');
const http = require('http');

function sign(secret, ts, raw) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
}

async function post(obs) {
  const api = process.env.API_URL || 'http://127.0.0.1:3001';
  const secret = process.env.INTERNAL_API_SECRET || 'internalsecret';
  const raw = JSON.stringify(obs);
  const ts = Date.now();
  const sig = sign(secret, ts, raw);

  const url = new URL('/internal/flow', api);

  const opts = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(raw),
      'x-mayhem-timestamp': String(ts),
      'x-mayhem-signature': sig,
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c.toString());
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

(async () => {
  const obs = {
    type: 'transaction',
    mint: 'DemoMintSigned1',
    ts: Date.now(),
    signature: 'DEMO-SIG-1',
    side: 'buy',
    volumeSol: 0.01,
    buyer: 'BuyerDemo',
    seller: null,
    price: 0.001,
    source: 'test-script'
  };

  try {
    const res = await post(obs);
    console.log('Posted signed observation:', res);
  } catch (err) {
    console.error('Post failed', err);
  }
})();
