'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { grab, extractLinks } = require('../src/grabber');

test('extractLinks makes links absolute and drops scripts/mail/anchors', () => {
  const links = extractLinks(`<a href="a.zip">x</a><a href='/b/c.pdf'></a><img src=//cdn.example.com/p.jpg>
    <a href="javascript:void(0)">j</a><a href="mailto:x@y">m</a><a href="#top">t</a>`, 'https://example.com/dir/page.html');
  assert.deepStrictEqual(links.sort(), ['https://cdn.example.com/p.jpg', 'https://example.com/b/c.pdf', 'https://example.com/dir/a.zip']);
});

test('grab finds files on the page and on linked pages of the same site', async () => {
  const pages = {
    '/': '<a href="/sub.html">sub</a> <a href="/files/one.zip">1</a> <a href="https://other.example/x.html">ext</a> <a href="pic.png">p</a>',
    '/sub.html': '<a href="two.mp4">2</a> <a href="/files/one.zip">dup</a> <a href="doc.pdf">d</a>',
  };
  const srv = http.createServer((req, res) => {
    if (pages[req.url]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[req.url]); } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const shallow = await grab({ url: base, depth: 0 });
    assert.deepStrictEqual(shallow.files.map((f) => f.name), ['one.zip']); // pictures are off by default
    const deep = await grab({ url: base, depth: 1, categories: ['Compressed', 'Video', 'Documents', 'Images'] });
    assert.deepStrictEqual(deep.files.map((f) => f.name).sort(), ['doc.pdf', 'one.zip', 'pic.png', 'two.mp4']);
    assert.equal(deep.pages, 2); // the other site was not visited
    const custom = await grab({ url: base, depth: 1, categories: [], custom: '.pdf' });
    assert.deepStrictEqual(custom.files.map((f) => f.name), ['doc.pdf']);
  } finally { srv.close(); }
});
