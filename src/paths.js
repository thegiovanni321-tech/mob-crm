// Data locations. The sanitized source replaced absolute data paths with ./data placeholders.
// These stay configurable: DATA_DIR, WORKBOOK_PATH, and DELTA_DIR. Defaults are the repo data folder,
// resolved from this file so they do not depend on the process working directory.
const path = require('path');
const ROOT = path.join(__dirname, '..');

function dataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
}
function workbookPath() {
  return path.resolve(process.env.WORKBOOK_PATH || path.join(dataDir(), 'Prospects_updated.xlsx'));
}
function deltaDir() {
  return path.resolve(process.env.DELTA_DIR || path.join(dataDir(), 'incoming'));
}

module.exports = { ROOT, dataDir, workbookPath, deltaDir };
