'use strict';
// Minimal HTTP(S) client with keep-alive pools, manual redirects, idle timeout.
// IDM ships its own HTTP stack (HTTPConnection/HTTPSession + OpenSSL) instead of WinINet,
// for the same reasons: exact control over Range headers, redirects and connection reuse.
const http = require('node:http');
const https = require('node:https');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
};

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

function normalizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v != null && v !== '') out[k.toLowerCase()] = String(v);
  return out;
}

/**
 * Open a request and resolve with the first non-redirect response.
 * @returns {Promise<{res: http.IncomingMessage, url: string}>}
 */
function request(url, { method = 'GET', headers = {}, timeout = 30000, maxRedirects = 10, signal } = {}) {
  const base = { 'user-agent': DEFAULT_UA, accept: '*/*', 'accept-encoding': 'identity', ...normalizeHeaders(headers) };
  const originHost = new URL(url).host;

  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (current, verb) => {
      let u;
      try { u = new URL(current); } catch (e) { return reject(e); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`Unsupported protocol ${u.protocol}`));
      const hdrs = { ...base };
      // Never leak cookies/credentials to a different host after a redirect (e.g. to a CDN).
      if (u.host !== originHost) { delete hdrs.cookie; delete hdrs.authorization; }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: verb, headers: hdrs, agent: agents[u.protocol], signal });
      req.setTimeout(timeout, () => req.destroy(new Error(`Timeout after ${timeout} ms`)));
      req.on('error', reject);
      req.on('response', (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          res.resume();
          if (++redirects > maxRedirects) return reject(new Error('Too many redirects'));
          return go(new URL(loc, current).href, res.statusCode === 303 ? 'GET' : verb);
        }
        resolve({ res, url: current });
      });
      req.end();
    };
    go(url, method);
  });
}

async function getBuffer(url, opts = {}) {
  const { res, url: finalUrl } = await request(url, opts);
  if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode, finalUrl); }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return { body: Buffer.concat(chunks), url: finalUrl, headers: res.headers, status: res.statusCode };
}

module.exports = { request, getBuffer, HttpError, DEFAULT_UA, normalizeHeaders };
