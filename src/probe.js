'use strict';
// Probe a URL: size, range support, file name, validators (ETag / Last-Modified).
// Uses "GET Range: bytes=0-" rather than HEAD: many CDNs answer HEAD differently from GET.
const path = require('node:path');
const { request, HttpError } = require('./http');
const { filenameFromDisposition, filenameFromUrl, extFromMime, sanitizeFilename } = require('./util');

// keepOpen: the answer's body (the file from byte 0) is returned as info.res, so a download can
// start writing it at once instead of asking the server again (what IDM does).
async function probe(url, { headers = {}, signal, timeout, keepOpen = false } = {}) {
  const { res, url: finalUrl } = await request(url, { headers: { ...headers, range: 'bytes=0-' }, signal, timeout });
  const h = res.headers;
  if (res.statusCode >= 400 || !keepOpen || (res.statusCode !== 200 && res.statusCode !== 206)) res.destroy(); // headers are all we need
  if (res.statusCode >= 400) throw new HttpError(res.statusCode, finalUrl);

  let size = null;
  let resumable = false;
  if (res.statusCode === 206) {
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
    if (m) { size = Number(m[1]); resumable = true; }
  } else if (h['content-length']) {
    size = Number(h['content-length']);
    // 200 to a ranged request: only trust ranges if the server advertises them.
    resumable = /bytes/i.test(h['accept-ranges'] || '');
  }
  if (h['content-encoding'] && h['content-encoding'] !== 'identity') resumable = false;

  const contentType = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  let filename = filenameFromDisposition(h['content-disposition']) || filenameFromUrl(finalUrl) || 'download';
  if (!path.extname(filename)) filename += extFromMime(contentType);

  const etag = h.etag && !/^W\//.test(h.etag) ? h.etag : null; // If-Range needs a strong validator
  return {
    finalUrl,
    size,
    resumable: resumable && size > 0,
    filename: sanitizeFilename(filename),
    contentType,
    etag,
    lastModified: h['last-modified'] || null,
    status: res.statusCode,
    res: res.destroyed ? null : res,
  };
}

module.exports = { probe };
