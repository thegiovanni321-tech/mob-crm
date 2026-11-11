"""Read prospect rows (General-tab layout) from an .xlsx tab or a delta .csv and print JSON property blocks to stdout.
Usage: python3 scripts/extract_general.py <file.xlsx|file.csv> [tab name, default General]
Never writes to the input file. Columns are matched by header name (extra columns are ignored), using the same
parsing helpers as scripts/extract.py. Layout: one row per owner contact; a row with a Building Address starts a property;
rows with an owner but no address are extra contacts of the property above; blank rows separate properties."""
import json, re, sys, os, csv, io, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
code = open(os.path.join(HERE, 'extract.py')).read().split('wb = openpyxl.load_workbook')[0]
ns = {'__name__': 'x'}; _argv = sys.argv; sys.argv = ['x', '', '']; exec(code, ns); sys.argv = _argv
s, d, num, state, CODES = ns['s'], ns['d'], ns['num'], ns['state'], ns['CODES']

FIELDS = {'calls': 'calls', 'tenancy': 'tenancy', 'buildingaddress': 'address', 'address': 'address', 'propertyaddress': 'address', 'city': 'city', 'state': 'state',
  'zip': 'zip', 'zipcode': 'zip', 'entity': 'entity', 'owner1': 'owner', 'owner': 'owner', 'ownername': 'owner', 'age': 'age',
  'phone1': 'phone1', 'phone2': 'phone2', 'phone3': 'phone3', 'phone4': 'phone4', 'phone5': 'phone5', 'email': 'email', 'website': 'website', 'notes': 'notes',
  'datetalkedto': 'talked', 'callback': 'callback', 'owneraddress': 'mailing_address', 'caprate': 'cap_rate', 'saledate': 'sale_date', 'price': 'price',
  'rba': 'rba', 'acres': 'acres', 'yearbuilt': 'year_built',
  'confirmedtenant': 'confirmed_tenant', 'confirmedtenants': 'confirmed_tenant'}
hnorm = lambda h: re.sub(r'[^a-z0-9]', '', str(h or '').lower())

def fail(msg): print(json.dumps({'ok': False, 'error': msg})); sys.exit(0)

def load(path, tab):
    """returns (headers, rows[(row_number, values, calls_fill)])"""
    if path.lower().endswith('.csv'):
        raw = open(path, 'rb').read()
        if not raw.strip(): fail('File is empty')
        for enc in ('utf-8-sig', 'cp1252'):
            try: text = raw.decode(enc); break
            except UnicodeDecodeError: continue
        else: fail('File is not UTF-8 or Windows-1252 text')
        try: data = list(csv.reader(io.StringIO(text)))
        except csv.Error as e: fail('CSV could not be parsed: %s' % e)
        if not data: fail('File is empty')
        return data[0], [(i, r, False) for i, r in enumerate(data[1:], start=2)], 'csv'
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if tab not in wb.sheetnames: fail('Tab "%s" not found' % tab)
    vals = list(wb[tab].iter_rows(values_only=True))
    if not vals: fail('Tab is empty')
    headers = list(vals[0]); ci = next((i for i, h in enumerate(headers) if hnorm(h) == 'calls'), None)
    has_calls = ci is not None and any(s(r[ci]) for r in vals[1:] if len(r) > ci)
    fills = {}
    if has_calls:  # CALLS is in use on this tab, so its cell color also means "called" (as in the original import)
        wbf = openpyxl.load_workbook(path)
        for i, row in enumerate(wbf[tab].iter_rows(min_row=2, min_col=ci + 1, max_col=ci + 1), start=2):
            f = row[0].fill; fills[i] = bool(f is not None and f.fill_type)
    return headers, [(i, list(r), fills.get(i, False)) for i, r in enumerate(vals[1:], start=2)], 'xlsx:' + tab + (' (CALLS used)' if has_calls else ' (CALLS empty: cell colors ignored)')

def main():
    if len(sys.argv) < 2: fail('usage: extract_general.py file [tab]')
    path, tab = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'General')
    if not os.path.exists(path): fail('File not found')
    headers, rows, kind = load(path, tab)
    col = {}
    for i, h in enumerate(headers):
        f = FIELDS.get(hnorm(h))
        if f and f not in col: col[f] = i
    ignored = [str(h) for i, h in enumerate(headers) if s(h) and i not in col.values()]
    if 'address' not in col: fail('Missing the "Building Address" column. Headers found: ' + ', '.join(str(h) for h in headers if s(h)))
    if 'owner' not in col and 'entity' not in col: fail('Missing both "Owner 1" and "Entity" columns')
    calls_used = kind.endswith('(CALLS used)') or (kind == 'csv' and 'calls' in col and any(s(r[col['calls']]) for _, r, _ in rows if len(r) > col['calls']))
    props, skipped, stats = [], [], dict(rows=0, blank_rows=0, property_rows=0, contact_rows=0)
    cur = None; blank_since = True
    for rn, r, filled in rows:
        g = lambda f: (r[col[f]] if f in col and col[f] < len(r) else None)
        if not any(s(x) for x in r): stats['blank_rows'] += 1; blank_since = True; continue
        stats['rows'] += 1
        addr, oname, entity = s(g('address')), s(g('owner')), s(g('entity'))
        talked, talked_raw = d(g('talked')); cb, cb_raw = d(g('callback'))
        called = calls_used and (bool(s(g('calls'))) or filled)
        age_n, age_raw = num(g('age'))
        contact = None
        if oname or entity:
            contact = dict(row=rn, name=oname, entity=entity, age=(str(int(age_n)) if age_n else age_raw), phones=[p for p in (s(g('phone%d' % k)) for k in range(1, 6)) if p],
                           email=s(g('email')), website=s(g('website')), mailing_address=s(g('mailing_address')))
        if addr:
            city, st, zp = s(g('city')), s(g('state')), s(g('zip'))
            stc, st_raw = state(st)
            if not stc and not st:
                m = re.search(r',\s*([^,]+?),\s*([A-Za-z]{2})\.?\s*(\d{5})?(-\d{4})?\s*$', addr)
                if m and m.group(2).upper() in CODES:
                    city = city or m.group(1).strip(); stc = m.group(2).upper(); zp = zp or m.group(3); addr = addr[:m.start()].strip()
            cap, cap_raw = num(g('cap_rate')); sale, sale_raw = d(g('sale_date')); price, price_raw = num(g('price'))
            rba, rba_raw = num(g('rba')); acres, acres_raw = num(g('acres'))
            cur = dict(row=rn, address=addr, city=city, state=stc, state_raw=st_raw, zip=zp, tenancy=s(g('tenancy')), confirmed_tenant=s(g('confirmed_tenant')), rba=rba, rba_raw=rba_raw, acres=acres,
                       year_built=s(g('year_built')), sale_date=sale, sale_date_raw=sale_raw, price=price, price_raw=price_raw, cap_rate=cap, cap_raw=cap_raw,
                       notes=[n for n in [s(g('notes'))] if n], raw_dates=[], contacts=[], imports=[])
            props.append(cur); stats['property_rows'] += 1
            if not stc: skipped.append(dict(row=rn, reason='kept, but state not recognized: %r' % st, text=addr))
        elif cur is None:
            txt = ' | '.join(t for t in (s(x) for x in r) if t)
            skipped.append(dict(row=rn, reason='no Building Address and no property above it', text=txt[:200])); continue
        elif blank_since:
            txt = ' | '.join(t for t in (s(x) for x in r) if t)
            skipped.append(dict(row=rn, reason='no Building Address, and it comes after a blank row (cannot tell which property it belongs to)', text=txt[:200])); continue
        else:
            stats['contact_rows'] += 1
            if not contact:
                extra = s(g('notes')) or ' | '.join(t for t in (s(x) for x in r) if t and not isinstance(t, datetime.datetime))
                if extra and extra not in cur['notes'] and not (talked or cb): cur['notes'].append(extra)
            elif s(g('notes')) and s(g('notes')) not in cur['notes']: cur['notes'].append(s(g('notes')))
        if contact: contact['idx'] = len(cur['contacts']); cur['contacts'].append(contact)
        for raw, lbl in ((talked_raw, 'Date Talked To'), (cb_raw, 'Last called')):
            if raw: cur['raw_dates'].append('%s: %s' % (lbl, raw))
        if talked or cb or called: cur['imports'].append(dict(row=rn, called=called, talked=talked, callback=cb, contact=(contact['idx'] if contact else None)))
        blank_since = False
    print(json.dumps(dict(ok=True, kind=kind, calls_colors_used=calls_used, ignored_columns=ignored, stats=stats, skipped=skipped, properties=props), default=str))
main()
