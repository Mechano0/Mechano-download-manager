const $ = (s) => document.querySelector(s);
const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));

function fmt(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }

async function send(url, kind, tab, btn) {
  btn.disabled = true;
  const r = await msg({ type: 'send', url, kind, pageUrl: tab.url });
  btn.textContent = r.ok ? 'Sent ✓' : 'Failed';
  if (!r.ok) btn.title = r.error;
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const r = await msg({ type: 'status', tabId: tab.id, tabUrl: tab.url });
  const s = r.data;
  $('#status').innerHTML = s.alive ? '<span class="ok">● app running</span>' : '<span class="err">● app not running</span>';
  $('#intercept').checked = s.intercept;
  $('#exts').value = s.exts;
  $('#port').value = s.port;
  $('#open').href = `http://127.0.0.1:${s.port}/`;
  $('#open').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: `http://127.0.0.1:${s.port}/` }); });

  if (!s.alive) $('#hint').textContent = 'Start Mechano DM (Start menu or desktop icon).';
  // Firefox asks for "all sites" access separately: offer the button when it is missing
  try {
    const all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!all) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Allow Mechano DM on all sites (needed)';
      b.onclick = async () => { if (await chrome.permissions.request({ origins: ['<all_urls>'] })) { b.textContent = 'Allowed ✓'; b.disabled = true; } };
      $('#page').appendChild(b);
    }
  } catch { /* Chrome: granted at install */ }
  if (s.mediaSite || (s.media.length === 0 && /^https?:/.test(tab.url))) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = s.mediaSite ? 'Download this video' : 'Try to download video on this page (yt-dlp)';
    b.onclick = () => send(tab.url, 'ytdlp', tab, b);
    $('#page').appendChild(b);
  }
  // YouTube playlist (a /playlist page, or a video opened from a playlist): download all of it.
  let list = null;
  try { const u = new URL(tab.url); if (/youtube\.com$/.test(u.hostname)) list = u.searchParams.get('list'); } catch {}
  if (list && !/^RD/.test(list)) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Download whole playlist';
    b.onclick = async () => {
      b.disabled = true;
      const r = await msg({ type: 'send', url: `https://www.youtube.com/playlist?list=${list}`, kind: 'ytdlp', playlist: true, pageUrl: tab.url });
      b.textContent = r.ok ? 'Sent ✓' : 'Failed';
      if (!r.ok) b.title = r.error;
    };
    $('#page').appendChild(b);
  }
  if (s.media.length) {
    $('#hint').textContent = `${s.media.length} media stream(s) detected on this tab:`;
    for (const m of s.media.slice().reverse()) {
      const li = document.createElement('li');
      const name = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || m.url);
      li.innerHTML = `<div><div class="k"></div><div class="u"></div></div>`;
      li.querySelector('.k').textContent = `${m.kind}${m.size ? ' · ' + fmt(m.size) : ''}`;
      li.querySelector('.u').textContent = name;
      li.querySelector('.u').title = m.url;
      const b = document.createElement('button');
      b.textContent = 'Download';
      b.onclick = () => send(m.url, m.kind, tab, b);
      li.appendChild(b);
      $('#media').appendChild(li);
    }
  }

  $('#save').addEventListener('click', async () => {
    await msg({ type: 'settings', settings: { intercept: $('#intercept').checked, exts: $('#exts').value, port: Number($('#port').value) || 9614 } });
    $('#save').textContent = 'Saved ✓';
  });
})();
