// Public place and ZIP centers for comps that have no property coordinates.
// Data: U.S. Census Bureau 2024 Gazetteer (place internal points and ZCTA internal points), public domain.
// These are city or ZIP-tabulation-area centers, not property locations and not inferred neighbors.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PROVENANCE = {
  publisher: 'U.S. Census Bureau',
  title: '2024 Census Gazetteer Files',
  files: ['2024_Gaz_place_national.txt', '2024_Gaz_zcta_national.txt'],
  retrieved: '2026-11-06',
  url: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/',
  license: 'U.S. government work, public domain',
};

let cached;
function load() {
  if (!cached) {
    const buf = fs.readFileSync(path.join(__dirname, 'census-2024.json.gz'));
    cached = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  }
  return cached;
}
function normKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}
function placePoint(city, state) {
  const st = String(state || '').trim().toUpperCase();
  const key = normKey(city);
  if (!st || !key) return null;
  const row = load().places[`${st}|${key}`];
  if (!row) return null;
  return { lat: row[0], lng: row[1], name: row[2], basis: 'city' };
}
function zipPoint(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const row = load().zips[z];
  if (!row) return null;
  return { lat: row[0], lng: row[1], basis: 'zip' };
}
function haversineMiles(aLat, aLng, bLat, bLng) {
  const R = 3958.7613;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function placesWithin(lat, lng, miles) {
  const out = [];
  const seen = new Set();
  for (const [key, row] of Object.entries(load().places)) {
    if (haversineMiles(lat, lng, row[0], row[1]) > miles) continue;
    const state = key.slice(0, 2);
    const norm = key.slice(3);
    const id = state + '|' + norm;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ state, norm });
  }
  return out;
}
function zipsWithin(lat, lng, miles) {
  const out = [];
  for (const [zip, row] of Object.entries(load().zips)) {
    if (haversineMiles(lat, lng, row[0], row[1]) <= miles) out.push(zip);
  }
  return out;
}
function places() { return load().places; }
function zips() { return load().zips; }

module.exports = { PROVENANCE, load, normKey, placePoint, zipPoint, placesWithin, zipsWithin, haversineMiles, places, zips };
