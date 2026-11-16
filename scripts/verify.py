"""Independent check: re-read the source workbook and compare with what's in the database.
Usage: python3 scripts/verify.py data/source_snapshot.xlsx db_counts.json data/seed.json"""
import openpyxl, json, sys, collections, re
src, dbf, seedf = sys.argv[1:4]
db = json.load(open(dbf)); seed = json.load(open(seedf))
wb = openpyxl.load_workbook(src, data_only=True)
rows_state = collections.Counter(); rows_tab = collections.Counter(); nonempty = 0
for ws in wb.worksheets:
    for r in list(ws.iter_rows(values_only=True))[1:]:
        r = list(r) + [None] * 26
        if not any(v is not None and str(v).strip() for v in r[:26]): continue
        nonempty += 1
        if r[2] is None or not str(r[2]).strip(): continue
        st = (str(r[4]).strip().upper() if r[4] else '') or None
        if not st:
            m = re.search(r',\s*([A-Za-z]{2})\.?\s*\d{5}', str(r[2])); st = m.group(1).upper() if m else 'Unknown'
        rows_state[st] += 1; rows_tab[ws.title.strip()] += 1
# rows merged as duplicates, by state and by tab (a row merged into an existing property in the SAME tab reduces that tab's count)
merged_state = collections.Counter(); merged_same_tab = collections.Counter()
for p in seed['properties']:
    merged_state[p['state'] or 'Unknown'] += len(p['rows']) - 1
    c = collections.Counter(s.rsplit(' row ', 1)[0] for s in p['srcs'])
    for t, n in c.items(): merged_same_tab[t] += n - 1
ok = True
print(f"non-empty source rows: {nonempty}; property rows: {sum(rows_state.values())}; DB properties: {db['totals']['p']}")
print('STATE  source_rows  merged_dupes  expected  in_db')
for st in sorted(set(rows_state) | set(db['state']), key=lambda s: -rows_state[s]):
    exp = rows_state[st] - merged_state[st]; got = db['state'].get(st, 0)
    flag = '' if exp == got else '  <-- MISMATCH'; ok &= exp == got
    print(f"{st:7} {rows_state[st]:11} {merged_state[st]:13} {exp:9} {got:6}{flag}")
bad = []
for t in sorted(set(rows_tab) | set(db['tenant'])):
    exp = rows_tab[t] - merged_same_tab[t]; got = db['tenant'].get(t, 0)
    if exp != got: bad.append((t, rows_tab[t], merged_same_tab[t], got))
print(f"tenants in DB: {len(db['tenant'])}; tenants with mismatched property counts: {len(bad)} {bad[:10]}")
print('per-tenant source property rows == DB properties for every tenant' if not bad else '')
ok &= not bad
print('RESULT:', 'ALL COUNTS MATCH' if ok else 'MISMATCHES FOUND'); sys.exit(0 if ok else 1)
