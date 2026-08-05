import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { CsvContact } from '../../shared';

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
}

// Parse a dropped CSV or Excel file client-side into headers + string rows.
export async function parseAudienceFile(file: File): Promise<ParsedFile> {
  const name = file.name.toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');

  if (isExcel) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, {
      defval: '',
      raw: false,
    });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    return {
      headers,
      rows: rows.map((r) => stringifyRow(r)),
    };
  }

  // CSV (also handles tab/semicolon/pipe delimited)
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      delimitersToGuess: [',', '\t', ';', '|'],
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        resolve({ headers, rows: results.data.map((r) => stringifyRow(r)) });
      },
      error: (err) => reject(err),
    });
  });
}

function stringifyRow(r: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    out[k] = v == null ? '' : String(v).trim();
  }
  return out;
}

// The fields we map file columns onto.
export type ContactField =
  | 'email'
  | 'phone_number'
  | 'first_name'
  | 'last_name'
  | 'company'
  | 'zip';

export const CONTACT_FIELDS: { key: ContactField; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'phone_number', label: 'Phone' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'zip', label: 'ZIP' },
];

// Guess a column for each field from header names (best-effort).
export function guessMapping(
  headers: string[]
): Partial<Record<ContactField, string>> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (...needles: string[]) =>
    headers.find((h) => {
      const n = norm(h);
      return needles.some((needle) => n === needle || n.includes(needle));
    });
  return {
    email: find('email', 'emailaddress'),
    phone_number: find('phone', 'phonenumber', 'mobile', 'cell'),
    first_name: find('firstname', 'fname', 'first'),
    last_name: find('lastname', 'lname', 'last'),
    company: find('company', 'organization', 'account'),
    zip: find('zip', 'zipcode', 'postal', 'postalcode'),
  };
}

export interface BuildResult {
  contacts: CsvContact[];
  usable: number;
  unusable: number;
}

// Turn parsed rows + a column mapping into the campaigns contract shape.
// A row is usable only if it has an email OR a phone.
export function buildContacts(
  rows: Record<string, string>[],
  mapping: Partial<Record<ContactField, string>>
): BuildResult {
  const pick = (row: Record<string, string>, field: ContactField) => {
    const col = mapping[field];
    const v = col ? row[col]?.trim() : '';
    return v || undefined;
  };

  const contacts: CsvContact[] = [];
  let unusable = 0;

  for (const row of rows) {
    const email = pick(row, 'email');
    const phone = pick(row, 'phone_number');
    if (!email && !phone) {
      unusable++;
      continue;
    }
    contacts.push({
      contact_information: {
        email: email ?? null,
        phone_number: phone ?? null,
        first_name: pick(row, 'first_name') ?? null,
        last_name: pick(row, 'last_name') ?? null,
      },
      input_data: {
        ...(pick(row, 'company') ? { company: pick(row, 'company')! } : {}),
        ...(pick(row, 'zip') ? { zip: pick(row, 'zip')! } : {}),
      },
    });
  }

  return { contacts, usable: contacts.length, unusable };
}
