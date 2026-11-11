// Data locations. The sanitized source replaced absolute data paths with ./data placeholders.
// These stay configurable: DATA_DIR, WORKBOOK_PATH, and DELTA_DIR. Defaults are the repo data folder,
// resolved from this file so they do not depend on the process working directory.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
// Pre-sanitizer box installs kept the workbook and delta CSVs at /workspace/data.
// Use that directory only when those files are actually there and it is not already the app data directory.
const LEGACY_DATA = '/workspace/data';

function dataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  const local = path.resolve(path.join(ROOT, 'data'));
  const legacy = path.resolve(LEGACY_DATA);
  if (legacy !== local) {
    const hasWorkbook = fs.existsSync(path.join(legacy, 'Prospects_updated.xlsx'));
    const hasIncoming = fs.existsSync(path.join(legacy, 'incoming'));
    if (hasWorkbook || hasIncoming) return legacy;
  }
  return local;
}
function workbookPath() {
  return path.resolve(process.env.WORKBOOK_PATH || path.join(dataDir(), 'Prospects_updated.xlsx'));
}
function deltaDir() {
  return path.resolve(process.env.DELTA_DIR || path.join(dataDir(), 'incoming'));
}

module.exports = { ROOT, dataDir, workbookPath, deltaDir };
