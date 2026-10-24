'use strict';

// Same-origin Vercel API proxy. Set BULLTRADE_BACKEND_URL to the HTTPS URL
// of the persistent Node backend (for example, the Render service URL).
// This is a fixed-origin proxy, not an arbitrary URL fetcher.
const http = require('http');
const https = require('https');

module.exports = function handler(req, res) {
  const configured = String(process.env.BULLTRADE_BACKEND_URL || '').trim();
  if (!configured) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({
      ok: false,
      error: 'Backend is not configured. Set BULLTRADE_BACKEND_URL in Vercel.'
    }));
  }

  let base;
  let target;
  try {
    base = new URL(configured);
    if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
      throw new Error('Backend URL must use HTTPS.');
    }
    target = new URL(req.url || '/api', base);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ok: false, error: 'Invalid backend URL configuration.' }));
  }

  if (target.origin !== base.origin || (target.pathname !== '/api' && !target.pathname.startsWith('/api/'))) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
  }

  const transport = target.protocol === 'https:' ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-authenticate'];
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  delete headers.upgrade;
  headers.host = target.host;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'https';

  const upstream = transport.request(target, {
    method: req.method,
    headers,
    timeout: 25000
  }, upstreamRes => {
    res.statusCode = upstreamRes.statusCode || 502;
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'].includes(name)) continue;
      if (value !== undefined) res.setHeader(name, value);
    }
    upstreamRes.pipe(res);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('Backend request timed out')));
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: false, error: 'Backend temporarily unavailable.' }));
  });

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
};
