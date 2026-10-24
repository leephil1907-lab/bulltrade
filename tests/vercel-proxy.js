'use strict';
const assert = require('assert');
const handler = require('../api/[...path].js');

function invoke(req) {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body || ''; },
    destroy() { this.destroyed = true; }
  };
  handler(req, res);
  return res;
}

(async () => {
  const previous = process.env.BULLTRADE_BACKEND_URL;
  try {
    delete process.env.BULLTRADE_BACKEND_URL;
    const missing = invoke({ method: 'GET', url: '/api/healthz', headers: { host: 'bulltrade.vercel.app' } });
    assert.strictEqual(missing.statusCode, 503, 'missing backend must fail clearly');
    assert.match(missing.body, /BULLTRADE_BACKEND_URL/);

    process.env.BULLTRADE_BACKEND_URL = 'https://backend.example';
    const blocked = invoke({ method: 'GET', url: '/healthz', headers: { host: 'bulltrade.vercel.app' } });
    assert.strictEqual(blocked.statusCode, 404, 'proxy must only forward /api paths');

    console.log('Vercel API proxy guard tests passed.');
  } finally {
    if (previous === undefined) delete process.env.BULLTRADE_BACKEND_URL;
    else process.env.BULLTRADE_BACKEND_URL = previous;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
