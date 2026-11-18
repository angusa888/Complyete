#!/usr/bin/env python3
"""Read the supplied tracker only. Never changes the workbook or uploads anything.
Use the bundled Python runtime (openpyxl) reported by load_workspace_dependencies.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import warnings

SHEETS = {
    'Project Tracker': (3, 166, 3, 15, 164),
    'Project Tracker (COMPLETED)': (5, None, 3, 14, 379),
    'Project Tracker (PROPOSALS)': (5, None, 2, 13, 14),
}
FIELDS = ['project_number', 'client_name', 'property_address', 'details',
          'original_status', 'notes', 'legacy_assignment', 'first_contact_date',
          'proposal_sent_date', 'proposal_accepted_date', 'filed_date', 'notes_2', 'meeting_date']
DATE_FIELDS = set(FIELDS[7:11] + ['meeting_date'])
NON_PEOPLE = {'field', 'office', 'tbd', 'n/a', 'na', 'none', 'all', 'staff', '?', '-'}

def text(value):
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip() or None

def raw_value(value):
    return {'kind': type(value).__name__, 'value': value.isoformat() if isinstance(value, (date, datetime)) else value}

def parse_date(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    if isinstance(value, (datetime, date)):
        parsed = value.date() if isinstance(value, datetime) else value
        # Preserve implausible historical dates as source, not a silently corrected date.
        if not 1900 <= parsed.year <= 2100:
            return None, 'date_out_of_range'
        return parsed.isoformat(), None
    if not isinstance(value, str):
        return None, 'unparsed_date'
    value = value.strip()
    formats = []
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        formats = ['%Y-%m-%d']
    elif re.fullmatch(r'\d{1,2}/\d{1,2}/\d{4}', value):
        formats = ['%m/%d/%Y']
    elif re.fullmatch(r'\d{1,2}/\d{1,2}/\d{2}', value):
        formats = ['%m/%d/%y']
    for fmt in formats:
        try:
            parsed = datetime.strptime(value, fmt).date()
            if not 1900 <= parsed.year <= 2100:
                return None, 'date_out_of_range'
            return parsed.isoformat(), None
        except ValueError:
            pass
    return None, 'unparsed_date'

def prepare(workbook: Path):
    from openpyxl import load_workbook
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', message='Print area cannot be set')
        formulas = load_workbook(workbook, read_only=False, data_only=False)
        cached = load_workbook(workbook, read_only=False, data_only=True)
    rows, counts = [], {}
    for sheet_name, (start, end, first, last, expected) in SHEETS.items():
        if sheet_name not in formulas.sheetnames:
            raise ValueError(f'Missing expected sheet: {sheet_name}')
        sheet, values = formulas[sheet_name], cached[sheet_name]
        count = 0
        for row_number in range(start, (end or sheet.max_row) + 1):
            cells = list(sheet.iter_rows(min_row=row_number, max_row=row_number, min_col=first, max_col=last))[0]
            if not any(c.value is not None and str(c.value).strip() for c in cells):
                continue
            count += 1
            source, mapped, flags = {}, {}, []
            for index, cell in enumerate(cells):
                field = FIELDS[index]
                value = values.cell(row_number, cell.column).value
                source[cell.coordinate] = {**raw_value(cell.value), 'data_type': cell.data_type, 'number_format': cell.number_format}
                if cell.data_type == 'f':
                    source[cell.coordinate]['cached'] = raw_value(value)
                    if value is None:
                        flags.append({'code': 'formula_without_cached_value', 'field': field, 'cell': cell.coordinate})
                if field in DATE_FIELDS:
                    mapped[field], error = parse_date(value)
                    if error:
                        flags.append({'code': error, 'field': field, 'cell': cell.coordinate})
                else:
                    mapped[field] = text(value)
            mapped.setdefault('meeting_date', None)
            mapped['notes'] = '\n\n'.join(v for v in [mapped.get('notes'), mapped.pop('notes_2', None)] if v) or None
            mapped['title'] = mapped.get('property_address') or mapped.get('project_number') or 'Imported project'
            assignment = mapped.get('legacy_assignment')
            names = re.split(r'\s*(?:,|/|&|;|\+|\n|\band\b)\s*', assignment or '', flags=re.IGNORECASE)
            mapped['staff_names'] = list(dict.fromkeys(n.strip() for n in names if n.strip() and n.strip().lower() not in NON_PEOPLE))
            if assignment and any(n.strip().lower() in NON_PEOPLE for n in names):
                flags.append({'code': 'non_person_assignment', 'field': 'legacy_assignment'})
            mapped['historical_completed_unverified'] = 'COMPLETED' in sheet_name or bool(re.search(r'\b(complete|completed|closed|done)\b', mapped.get('original_status') or '', re.I))
            if mapped['historical_completed_unverified']:
                flags.append({'code': 'historical_completion_unverified'})
            if not mapped.get('client_name'):
                flags.append({'code': 'missing_client_label'})
            rows.append({'source_sheet': sheet_name, 'source_row': row_number, 'source_cells': source,
                         'mapped_values': mapped, 'validation_flags': flags})
        counts[sheet_name] = count
        if count != expected:
            raise ValueError(f'{sheet_name}: expected {expected} populated rows, found {count}; review source range')
    # Collision flags are advisory. Exact trimmed labels group; fuzzy labels never merge.
    labels = defaultdict(set)
    numbers = Counter(row['mapped_values'].get('project_number') for row in rows if row['mapped_values'].get('project_number'))
    for row in rows:
        name = row['mapped_values'].get('client_name')
        if name:
            labels[name.casefold()].add(name)
    for row in rows:
        mapped = row['mapped_values']
        if mapped.get('client_name') and len(labels[mapped['client_name'].casefold()]) > 1:
            row['validation_flags'].append({'code': 'possible_client_identity_collision'})
        if numbers[mapped.get('project_number')] > 1:
            row['validation_flags'].append({'code': 'duplicate_project_number_preserved'})
    summary = {'total_rows': len(rows), 'sheet_counts': counts,
               'exact_client_labels': len({r['mapped_values']['client_name'] for r in rows if r['mapped_values']['client_name']}),
               'flag_counts': dict(Counter(f['code'] for r in rows for f in r['validation_flags'])),
               'date_flag_cells': [{'sheet': r['source_sheet'], 'row': r['source_row'], 'cell': f['cell'], 'field': f['field'], 'code': f['code']}
                                   for r in rows for f in r['validation_flags'] if f['code'] in ('unparsed_date', 'date_out_of_range')]}
    return {'format_version': 1, 'workbook_sha256': hashlib.sha256(workbook.read_bytes()).hexdigest(),
            'filename': workbook.name, 'expected_rows': 557, 'summary': summary, 'rows': rows}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--output', type=Path, default=Path('.env.import-tracker.local'))
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.name.startswith('.env'):
        parser.error('Raw import payload must use a Git-ignored .env* filename')
    try:
        relative = output.relative_to(Path.cwd().resolve())
    except ValueError:
        parser.error('Output must be inside the current repository')
    ignored = subprocess.run(['git', 'check-ignore', '--quiet', '--no-index', str(relative)], check=False)
    if ignored.returncode != 0:
        parser.error('Output is not Git-ignored; refusing to write client source data')
    payload = prepare(args.workbook.resolve(strict=True))
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'output': str(relative), 'workbook_sha256': payload['workbook_sha256'], **payload['summary']}, indent=2))

if __name__ == '__main__':
    main()
