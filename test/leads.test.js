const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASSWORD = 'synthetic-test-password';
function startServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NODE_ENV: 'test', DELTA_WATCH: '0', APP_PASSWORD: PASSWORD, SESSION_SECRET: 'synthetic-test-secret-value', DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const onData = (buf) => { log += buf.toString(); if (log.includes('MOB CRM on')) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + log)));
    setTimeout(() => reject(new Error('timeout\n' + log)), 30000);
  });
}
function client(port) {
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async login() {
      const res = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
      return (res.headers.get('set-cookie') || '').split(';')[0];
    },
    async post(cookie, url, fields) {
      const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: new URLSearchParams(fields), redirect: 'manual' });
      return res.headers.get('location') || '';
    },
    async text(cookie, url) {
      return (await fetch(base + url, { headers: { cookie } })).text();
    },
  };
}

test('marking a lead moves it off the ranked list, keeps call count, and preserves Callbacks next', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-leads-'));
  const api = client(3469);
  const child = await startServer(dataDir, 3469);
  const countOf = (html) => Number((html.match(/(\d+) calls? today/) || [])[1]);
  try {
    const cookie = await api.login();
    const before = countOf(await api.text(cookie, '/'));
    async function make(address, state, notes, callback) {
      const loc = await api.post(cookie, '/properties', { address, city: 'Sampleville', state, status: 'New', o_name: address.split(' ')[0] + ' Sample', o_entity: 'Sample LLC', o_phone1: '555-0100' });
      const id = loc.match(/\/properties\/(\d+)/)[1];
      const page = await api.text(cookie, `/properties/${id}`);
      const owner = page.match(/name="owner_id"[\s\S]*?<option value="(\d+)">/)[1];
      await api.post(cookie, `/properties/${id}/activities`, { kind: 'call', outcome: 'Talked', owner_id: owner, activity_date: '2020-01-15', notes, callback_date: callback || '' });
      return id;
    }
    const alpha = await make('Alpha Lead Plaza', 'FL', 'She is interested in selling.');
    const bravo = await make('Bravo Still Calling', 'GA', 'Please call back in 3 months.');
    const ranked = await api.text(cookie, '/callbacks');
    assert.match(ranked, new RegExp(`/properties/${alpha}\\?from=cb`));
    assert.match(ranked, new RegExp(`/properties/${bravo}\\?from=cb`));
    const marked = await api.post(cookie, `/properties/${alpha}/lead`, { lead_note: 'Wants a valuation', from: 'cb', cb_at: '0' });
    assert.match(marked, new RegExp(`/properties/${alpha}\\?`));
    assert.match(marked, /from=cb/);
    assert.match(marked, /cb_at=0/);
    const page = await api.text(cookie, marked);
    assert.match(page, /badge lead/);
    assert.match(page, /Wants a valuation/);
    assert.match(page, /Remove from leads/);
    assert.match(page, /Marked as lead/);
    assert.match(page, new RegExp(`href="/properties/${bravo}\\?from=cb`));
    assert.equal(countOf(page), before);
    const notes = await api.text(cookie, `/properties/${alpha}`);
    assert.doesNotMatch(notes, /<h2>Notes<\/h2>[\\s\\S]*Wants a valuation/);
    const callbacks = await api.text(cookie, '/callbacks');
    const likely = callbacks.split('id="likely"')[1].split('id="due"')[0] || callbacks.split('id="likely"')[1];
    assert.doesNotMatch(likely, /Alpha Lead Plaza/);
    assert.match(likely, /Bravo Still Calling/);
    const leads = await api.text(cookie, '/leads');
    assert.match(leads, /Leads \(1\)/);
    assert.match(leads, /Alpha Lead Plaza/);
    assert.match(leads, /Wants a valuation/);
    assert.match(leads, /555-0100/);
    assert.match(leads, /interested in selling/);
    assert.match(leads, new RegExp(`/properties/${alpha}\\?from=leads`));
    const soonId = await make('Charlie Scheduled', 'FL', 'Talked and set a callback.', '2026-11-20');
    await api.post(cookie, `/properties/${soonId}/lead`, { lead_note: 'Call next week' });
    const withSched = await api.text(cookie, '/callbacks');
    assert.match(withSched, /Charlie Scheduled/);
    assert.match(withSched, /badge lead/);
    const both = await api.text(cookie, '/leads');
    assert.ok(both.indexOf('Charlie Scheduled') < both.indexOf('Alpha Lead Plaza'));
    const opened = await api.text(cookie, `/properties/${soonId}?from=leads&ld_at=0`);
    assert.match(opened, /Back to Leads/);
    assert.match(opened, new RegExp(`href="/properties/${alpha}\\?from=leads`));
    await api.post(cookie, `/properties/${alpha}/unlead`, { from: 'leads', ld_at: '1' });
    const back = await api.text(cookie, '/callbacks');
    assert.match(back.split('id="likely"')[1], /Alpha Lead Plaza/);
    const hidden = await api.text(cookie, '/leads');
    assert.doesNotMatch(hidden, /Alpha Lead Plaza/);
  } finally {
    child.kill('SIGTERM');
  }
});
