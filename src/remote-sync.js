// Box-side push worker. When ./.remote-sync.json exists ({"url": "https://<hosted app>", "token_file": ".railway-sync-token"}),
// the box copy of the CRM is NOT live: the hosted app (Railway Postgres) is the single source of truth, and this worker
// pushes the box's inputs to it over HTTPS (the box cannot reach the Railway database directly):
//   - ./data/incoming/crm-delta-*.csv  -> POST /api/sync/delta, then moved to crm-delta-processed/ (+ .result.json) or crm-delta-failed/ (+ .error.txt)
//   - ./data/Prospects_updated.xlsx, whenever it is saved -> POST /api/sync/workbook (General tab, same idempotent rules)
// scripts/fetch_public_sales.js also pushes its comps here (POST /api/sync/sale-comps) when this config exists.
const fs = require('fs'); const path = require('path');
const paths = require('./paths');
const ROOT = paths.ROOT;
const CONFIG = process.env.REMOTE_SYNC_CONFIG || path.join(ROOT, '.remote-sync.json');
const statePath = () => path.join(paths.dataDir(), 'remote-sync-state.json');

function loadConfig() {
  if (process.env.DATABASE_URL || !fs.existsSync(CONFIG)) return null;
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const tokenFile = path.resolve(ROOT, c.token_file || '.railway-sync-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return { url: c.url.replace(/\/+$/, ''), token, dir: c.delta_dir || paths.deltaDir(), workbook: c.workbook || paths.workbookPath() };
}

async function push(cfg, route, body, contentType) {
  const res = await fetch(cfg.url + '/api/sync/' + route, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': contentType }, body, signal: AbortSignal.timeout(300000) });
  let j; try { j = await res.json(); } catch { j = { error: 'HTTP ' + res.status }; }
  return { httpStatus: res.status, ...j };
}

function startRemoteWorker(cfg, { everyMs = 60000, log = console.log } = {}) {
  const done = path.join(cfg.dir, 'crm-delta-processed'); const failed = path.join(cfg.dir, 'crm-delta-failed');
  const sizes = new Map(); let busy = false;
  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } };
  const writeState = (s) => { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(s, null, 1)); };
  const dest = (folder, name) => { let p = path.join(folder, name); if (fs.existsSync(p)) p = path.join(folder, name.replace(/\.csv$/i, '') + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv'); return p; };
  async function tick() {
    if (busy) return; busy = true;
    try {
      // 1. delta CSVs
      const files = fs.existsSync(cfg.dir) ? fs.readdirSync(cfg.dir).filter((f) => /^crm-delta-.*\.csv$/i.test(f)).sort() : [];
      for (const f of files) {
        const full = path.join(cfg.dir, f); let st; try { st = fs.statSync(full); } catch { continue; }
        const prev = sizes.get(f); sizes.set(f, st.size);
        if (prev !== st.size || Date.now() - st.mtimeMs < 10000) continue; // wait until the file stops changing
        let r;
        try { r = await push(cfg, 'delta?name=' + encodeURIComponent(f), fs.readFileSync(full), 'text/csv'); }
        catch (e) { log(`[remote-sync] ${f}: hosted app unreachable (${e.message}); will retry next minute`); continue; }
        if (r.httpStatus >= 500 || r.httpStatus === 401 || r.httpStatus === 429) { log(`[remote-sync] ${f}: hosted app answered ${r.httpStatus} (${r.error || ''}); will retry`); continue; }
        sizes.delete(f); fs.mkdirSync(done, { recursive: true }); fs.mkdirSync(failed, { recursive: true });
        if (r.status === 'ok') {
          const to = dest(done, f); fs.renameSync(full, to); const { httpStatus, ...rest } = r;
          fs.writeFileSync(to + '.result.json', JSON.stringify({ file: f, processed_at: new Date().toISOString(), imported_into: cfg.url, ...rest }, null, 1));
          log(`[remote-sync] ${f} -> ${cfg.url}: ${r.new_properties} new properties, ${r.existing_properties_enriched} enriched, ${r.new_owners} new owners, ${(r.skipped || []).length} rows skipped`);
        } else {
          const to = dest(failed, f); fs.renameSync(full, to);
          fs.writeFileSync(to + '.error.txt', `${new Date().toISOString()}\n${f} was NOT imported (no changes were made).\nReason: ${r.error}\n\nFix the file and save it again as ${path.join(cfg.dir, f)}.\n`);
          log(`[remote-sync] ${f} FAILED: ${r.error}`);
        }
      }
      // 2. the workbook, when it has been saved since the last push (and not touched for 30 s)
      if (fs.existsSync(cfg.workbook)) {
        const st = fs.statSync(cfg.workbook); const s = readState();
        let requested = false;
        try { const q = await fetch(cfg.url + '/api/sync/requests', { headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(30000) }); requested = q.ok && (await q.json()).workbook; } catch { /* offline: ignore */ }
        if (requested || (st.mtimeMs !== s.workbook_mtime && Date.now() - st.mtimeMs > 30000)) {
          const copy = path.join(require('os').tmpdir(), 'prospects_push_copy.xlsx'); fs.copyFileSync(cfg.workbook, copy); // read-only copy
          try {
            const r = await push(cfg, 'workbook', fs.readFileSync(copy), 'application/octet-stream');
            if (r.status === 'ok') { writeState({ ...s, workbook_mtime: st.mtimeMs, workbook_pushed_at: new Date().toISOString(), last_result: { new_properties: r.new_properties, new_owners: r.new_owners, enriched: r.existing_properties_enriched, skipped: (r.skipped || []).length } });
              if (requested) await push(cfg, 'requests/done', '{}', 'application/json').catch(() => {});
              log(`[remote-sync] workbook General tab -> ${cfg.url}: ${r.new_properties} new properties, ${r.new_owners} new owners, ${r.existing_properties_enriched} enriched`); }
            else log(`[remote-sync] workbook push failed (${r.httpStatus}): ${r.error}; will retry`);
          } catch (e) { log(`[remote-sync] workbook push: hosted app unreachable (${e.message}); will retry`); } finally { fs.rmSync(copy, { force: true }); }
        }
      }
    } catch (e) { log('[remote-sync] error: ' + e.message); } finally { busy = false; }
  }
  const timer = setInterval(tick, everyMs); timer.unref?.(); setTimeout(tick, 5000).unref?.();
  log(`[remote-sync] box copy is read-only; pushing ${cfg.dir}/crm-delta-*.csv and the workbook to ${cfg.url} every ${Math.round(everyMs / 1000)}s`);
  return { tick };
}
module.exports = { loadConfig, push, startRemoteWorker };
