"""Convert the prospects workbook (one tab per tenant group) into data/seed.json.
Usage: python3 scripts/extract.py data/source_snapshot.xlsx data/seed.json
Never modifies the workbook."""
import openpyxl, json, re, sys, datetime, collections
SRC, OUT = sys.argv[1], sys.argv[2]
STATES = {'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA','COLORADO':'CO','CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA','HAWAII':'HI','IDAHO':'ID','ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA','KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA','MAINE':'ME','MARYLAND':'MD','MASSACHUSETTS':'MA','MICHIGAN':'MI','MINNESOTA':'MN','MISSISSIPPI':'MS','MISSOURI':'MO','MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ','NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH','OKLAHOMA':'OK','OREGON':'OR','PENNSYLVANIA':'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD','TENNESSEE':'TN','TEXAS':'TX','UTAH':'UT','VERMONT':'VT','VIRGINIA':'VA','WASHINGTON':'WA','WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY','DISTRICT OF COLUMBIA':'DC','PUERTO RICO':'PR'}
CODES = set(STATES.values())
def s(v):
    if v is None: return None
    if isinstance(v, float) and v.is_integer(): v = int(v)
    t = re.sub(r'\s+', ' ', str(v)).strip()
    return t or None
def d(v):
    if isinstance(v, datetime.datetime): return v.date().isoformat(), None
    if isinstance(v, datetime.date): return v.isoformat(), None
    t = s(v)
    if not t: return None, None
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})$', t)
    if m:
        mo, da, yr = map(int, m.groups()); yr += 2000 if yr < 100 else 0
        try: return datetime.date(yr, mo, da).isoformat(), None
        except ValueError: pass
    return None, t
def num(v):
    if isinstance(v, (int, float)): return v, None
    t = s(v)
    if not t: return None, None
    c = re.sub(r'[$,\s]', '', t)
    try: return float(c), None
    except ValueError: return None, t
def state(v):
    t = s(v)
    if not t: return None, None
    u = t.upper().replace('.', '').strip()
    if u in CODES: return u, None
    if u in STATES: return STATES[u], None
    return None, t
def norm_addr(a): return re.sub(r'[^a-z0-9]', '', (a or '').lower())
def norm_name(n):
    n = (n or '').lower()
    n = re.sub(r'\b(dr|md|m\.d|do|dds|dmd|od|phd|jr|sr)\b\.?', ' ', n)
    return re.sub(r'[^a-z]', '', n)
def digits(p): return re.sub(r'\D', '', p or '')[-10:]

wb = openpyxl.load_workbook(SRC)  # formatting needed for the green CALLS fill
tenants, props, prop_by_key = [], [], {}
owners, owner_index = [], collections.defaultdict(list)
report = collections.defaultdict(list); stats = collections.Counter()
src_rows_per_tab = collections.Counter(); src_props_per_tab = collections.Counter(); src_state = collections.Counter()

def get_owner(name, entity, age, phones, email, website, maddr, tab):
    nn = norm_name(name) or ('entity:' + norm_addr(entity) if entity else None)
    if not nn: return None
    ph = {digits(p) for p in phones if digits(p)}
    for o in owner_index[nn]:
        ophones = {digits(p) for p in o['phones'] if digits(p)}
        if (ph & ophones) or (not ph or not ophones) and (not entity or not o['entity'] or norm_addr(entity) == norm_addr(o['entity'])):
            for p in phones:
                if p and digits(p) not in {digits(x) for x in o['phones']} and len(o['phones']) < 5: o['phones'].append(p)
                elif p and digits(p) not in {digits(x) for x in o['phones']}: o['extra_phones'].append(p)
            for k, v in (('entity', entity), ('age', age), ('email', email), ('website', website), ('mailing_address', maddr), ('name', name)):
                if v and not o.get(k): o[k] = v
            stats['owner_rows_merged_into_existing_owner'] += 1
            return o['key']
    o = dict(key=len(owners) + 1, name=name, entity=entity, age=age, phones=[p for p in phones if p][:5], extra_phones=[p for p in phones if p][5:],
             email=email, website=website, mailing_address=maddr, source_tab=tab)
    owners.append(o); owner_index[nn].append(o)
    return o['key']

for ws in wb.worksheets:
    rows = list(ws.iter_rows())
    if not rows or rows[0][0].value is None and all(c.value is None for c in rows[0]):
        report['empty_tabs'].append(ws.title); continue
    tname = ws.title.strip()
    tenants.append(dict(name=tname, source_tab=ws.title, notes=[]))
    last_prop = None
    for r_i, row in enumerate(rows[1:], start=2):
        v = [c.value for c in row] + [None] * 26
        if not any(s(x) for x in v[:26]):
            continue
        src_rows_per_tab[tname] += 1
        tenancy, addr, city, st, zp, entity, oname = (s(x) for x in v[1:8])
        age_n, age_raw = num(v[8])
        phones = [s(x) for x in v[9:14]]
        email, website, notes = s(v[14]), s(v[15]), s(v[16])
        talked, talked_raw = d(v[17]); cb, cb_raw = d(v[18])
        maddr = s(v[19])
        cap, cap_raw = num(v[20]); sale, sale_raw = d(v[21]); price, price_raw = num(v[22])
        rba, rba_raw = num(v[23]); acres, acres_raw = num(v[24]); yb = s(v[25])
        called = bool(row[0].fill is not None and row[0].fill.fill_type) or s(v[0]) is not None
        if email and '@' in email and not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
            report['multi_or_incomplete_emails_kept_as_is'].append(f'{tname} r{r_i}: {email}')
        if not addr and last_prop is None:
            # text at the top of a tab before any property (e.g. "backed by X") -> tenant-level note
            txt = ' | '.join(t for t in (s(x) for x in v[:26]) if t)
            tenants[-1].setdefault('notes', []).append(txt)
            report['tenant_notes_from_rows_without_property'].append(f'{tname} r{r_i}: {txt}')
            stats['rows_saved_as_tenant_notes'] += 1
            continue
        okey = get_owner(oname, entity, str(int(age_n)) if age_n else age_raw, phones, email, website, maddr, tname)
        if age_raw: report['unparsed_age'].append(f'{tname} r{r_i}: {age_raw}')
        if not addr:
            # owner-only row: an additional contact for the property above it on the same tab
            if last_prop is not None:
                p = props[last_prop]
                if okey and okey not in p['owner_keys']: p['owner_keys'].append(okey)
                if not okey:
                    extra = ' | '.join(t for t in (s(x) for x in (v[1], v[9], v[10])) if t)
                    if extra: notes = (notes + ' | ' + extra) if notes else extra
                    stats['rows_without_owner_merged_into_property_above'] += 1
                if notes and notes not in p['notes']: p['notes'].append(notes)
                if talked or cb or called:
                    p['imports'].append(dict(tenant=tname, row=r_i, called=called, talked=talked, callback=cb, contact=okey))
                stats['owner_only_rows_attached_to_property_above'] += 1
            else:
                report['owner_rows_without_property'].append(f'{tname} r{r_i}: {oname or entity}')
                stats['owner_only_rows_kept_as_unlinked_owner'] += 1
            continue
        stats['property_rows'] += 1
        src_props_per_tab[tname] += 1
        stc, st_raw = state(st)
        if not stc and not st:
            m = re.search(r',\s*([^,]+?),\s*([A-Za-z]{2})\.?\s*(\d{5})?(-\d{4})?\s*$', addr)
            if m and m.group(2).upper() in CODES:
                city = city or m.group(1).strip(); stc = m.group(2).upper(); zp = zp or m.group(3)
                addr = addr[:m.start()].strip()
                stats['state_parsed_from_address'] += 1
        if st_raw: report['unparsed_state_values'].append(f'{tname} r{r_i}: {st_raw}')
        if st and stc and st != stc: stats['state_values_normalized'] += 1
        src_state[stc or 'Unknown'] += 1
        key = (norm_addr(addr), norm_addr(city), stc)
        if key in prop_by_key:
            idx = prop_by_key[key]; p = props[idx]
            report['merged_duplicates'].append(f'{addr}, {city} {stc}: {p["tenants"][0]} r{p["rows"][0]} + {tname} r{r_i}')
            stats['duplicate_rows_merged'] += 1
        else:
            idx = len(props); prop_by_key[key] = idx
            p = dict(address=addr, city=city, state=stc, state_raw=st_raw, zip=s(zp), tenancy=None, rba=None, rba_raw=None, acres=None,
                     year_built=None, sale_date=None, sale_date_raw=None, price=None, price_raw=None, cap_rate=None,
                     tenants=[], rows=[], owner_keys=[], notes=[], imports=[], called=False, last_talked=None, callback=None, raw_dates=[])
            props.append(p)
        for k, val in (('tenancy', tenancy), ('rba', rba), ('rba_raw', rba_raw), ('acres', acres), ('year_built', yb), ('sale_date', sale),
                       ('sale_date_raw', sale_raw), ('price', price), ('price_raw', price_raw), ('cap_rate', cap), ('zip', s(zp))):
            if val is not None and p.get(k) is None: p[k] = val
        if tname not in p['tenants']: p['tenants'].append(tname)
        p['rows'].append(r_i); p.setdefault('srcs', []).append(f'{tname} row {r_i}')
        if okey and okey not in p['owner_keys']: p['owner_keys'].append(okey)
        if notes and notes not in p['notes']: p['notes'].append(notes)
        for raw, lbl in ((talked_raw, 'Date Talked To'), (cb_raw, 'Call Back')):
            if raw: p['raw_dates'].append(f'{lbl}: {raw}'); report['unparsed_dates'].append(f'{tname} r{r_i} {lbl}: {raw}')
        if talked or cb or called:
            p['imports'].append(dict(tenant=tname, row=r_i, called=called, talked=talked, callback=cb, contact=okey))
        last_prop = idx

for p in props:
    p['called'] = any(i['called'] for i in p['imports'])
    t = [i['talked'] for i in p['imports'] if i['talked']]; c = [i['callback'] for i in p['imports'] if i['callback']]
    p['last_talked'] = max(t) if t else None; p['callback'] = max(c) if c else None
    p['status'] = 'Talked' if p['last_talked'] else ('Attempted' if p['called'] or p['callback'] else 'New')

per_tenant_unique = collections.Counter(t for p in props for t in p['tenants'])
out = dict(generated=datetime.datetime.now().isoformat(timespec='seconds'), tenants=tenants, owners=owners, properties=props,
           checks=dict(source_nonempty_rows=sum(src_rows_per_tab.values()), source_property_rows=stats['property_rows'],
                       source_property_rows_per_tab=src_props_per_tab, source_property_rows_per_state=src_state,
                       unique_properties_per_tenant=per_tenant_unique, unique_properties=len(props), owners=len(owners), stats=stats),
           report=report)
json.dump(out, open(OUT, 'w'), indent=1, default=str)
print(json.dumps(out['checks']['stats'], indent=1)); print('rows', out['checks']['source_nonempty_rows'], 'props', len(props), 'owners', len(owners), 'tenants', len(tenants))
for k, v in report.items(): print(k, len(v), v[:6])
print(sorted(src_state.items(), key=lambda x: -x[1]))
