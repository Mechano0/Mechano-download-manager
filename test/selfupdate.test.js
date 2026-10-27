'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyManifest, signedText, newer } = require('../src/selfupdate');

function signed(manifest) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const m = { ...manifest };
  m.signature = crypto.sign(null, Buffer.from(signedText(m)), privateKey).toString('base64');
  return { m, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const base = { version: '1.2.0', notes: 'x', setup: { url: 'https://github.com/a/b/releases/download/v1.2.0/S.exe', size: 10, sha256: 'a'.repeat(64) } };

test('a correctly signed version.json is accepted', () => {
  const { m, pub } = signed(base);
  assert.equal(verifyManifest(m, pub), true);
});

test('any change to a signed version.json is refused', () => {
  const { m, pub } = signed(base);
  assert.equal(verifyManifest({ ...m, setup: { ...m.setup, sha256: 'b'.repeat(64) } }, pub), false);
  assert.equal(verifyManifest({ ...m, version: '9.9.9' }, pub), false);
  assert.equal(verifyManifest({ ...m, signature: undefined }, pub), false);
});

test('a version.json signed with another key is refused', () => {
  const { m } = signed(base);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(verifyManifest(m, other), false);
});

test('plain http installer links are refused even when signed', () => {
  const { m, pub } = signed({ ...base, setup: { ...base.setup, url: 'http://example.com/S.exe' } });
  assert.equal(verifyManifest(m, pub), false);
});

test('version comparison', () => {
  assert.equal(newer('1.10.0', '1.9.3'), true);
  assert.equal(newer('1.1.0', '1.1.0'), false);
  assert.equal(newer('1.0.9', '1.1.0'), false);
});
