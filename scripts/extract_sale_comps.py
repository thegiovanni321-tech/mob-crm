"""Pull every workbook row that has a Sale Date and/or Price into data/sale_comps_seed.json (one entry per row).
Usage: python3 scripts/extract_sale_comps.py [workbook.xlsx] [out.json]
Default workbook: a fresh read-only COPY of WORKBOOK_PATH, or DATA_DIR/Prospects_updated.xlsx
(the original is never opened for writing), falling back to data/source_snapshot.xlsx.
Uses the same column layout and parsing rules as scripts/extract.py."""
import openpyxl, json, re, sys, os, shutil, datetime, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
DATA = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
LIVE = os.environ.get('WORKBOOK_PATH') or os.path.join(DATA, 'Prospects_updated.xlsx')
src = sys.argv[1] if len(sys.argv) > 1 else None
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'data', 'sale_comps_seed.json')
if not src:
    if os.path.exists(LIVE):
        src = os.path.join(tempfile.gettempdir(), 'prospects_live_copy.xlsx'); shutil.copyfile(LIVE, src); label = LIVE
    else:
        src = os.path.join(ROOT, 'data', 'source_snapshot.xlsx'); label = src
else: label = src
sys.path.insert(0, HERE)
# reuse the parsing helpers from extract.py without running it
code = open(os.path.join(HERE, 'extract.py')).read().split('wb = openpyxl.load_workbook')[0]
ns = {'__name__': 'x'}; sys_argv = sys.argv; sys.argv = ['x', '', '']; exec(code, ns); sys.argv = sys_argv
s, d, num, state = ns['s'], ns['d'], ns['num'], ns['state']; CODES = ns['CODES']
wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
rows = []; stats = dict(rows_with_sale_data=0, rows_without_address_attached_to_property_above=0, rows_without_address_skipped=0)
for ws in wb.worksheets:
    tname = ws.title.strip(); last = None
    for r_i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if r_i == 1: continue
        v = list(row) + [None] * 26
        if not any(s(x) for x in v[:26]): continue
        tenancy, addr, city, st, zp, entity, oname = (s(x) for x in v[1:8])
        if addr:
            stc, st_raw = state(st)
            if not stc and not st:
                m = re.search(r',\s*([^,]+?),\s*([A-Za-z]{2})\.?\s*(\d{5})?(-\d{4})?\s*$', addr)
                if m and m.group(2).upper() in CODES:
                    city = city or m.group(1).strip(); stc = m.group(2).upper(); zp = zp or m.group(3); addr = addr[:m.start()].strip()
            last = dict(address=addr, city=city, state=stc, state_raw=st_raw, zip=s(zp), tenancy=tenancy)
        cap, cap_raw = num(v[20]); sale, sale_raw = d(v[21]); price, price_raw = num(v[22])
        if not (sale or sale_raw or price is not None or price_raw): continue
        base = last if (addr or last) else None
        if not base: stats['rows_without_address_skipped'] += 1; continue
        if not addr: stats['rows_without_address_attached_to_property_above'] += 1
        rba, rba_raw = num(v[23]); acres, _ = num(v[24])
        stats['rows_with_sale_data'] += 1
        rows.append(dict(base, tab=tname, row=r_i, sale_date=sale, sale_date_raw=sale_raw, price=price, price_raw=price_raw,
                         cap_rate=cap if cap is None or cap < 1 else cap / 100, cap_raw=cap_raw, rba=rba, rba_raw=rba_raw, acres=acres,
                         year_built=s(v[25]), entity=entity, owner=oname))
json.dump(dict(generated=datetime.datetime.now().isoformat(timespec='seconds'), source=label, stats=stats, rows=rows), open(out, 'w'), indent=1, default=str)
print(json.dumps(dict(source=label, **stats)))
