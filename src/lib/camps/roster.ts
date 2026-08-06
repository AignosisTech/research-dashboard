import type { GroundTruth } from '@/lib/api/research';
import { campRosterRowSchema } from '@/lib/validations/campRoster';

import { buildRosterGroundTruth, ROSTER_GROUND_TRUTH_LABELS } from './groundTruthMap';

/**
 * Camp roster Excel parsing and template generation.
 *
 * exceljs is only ever loaded via dynamic import so the (large) parser stays in
 * its own lazy chunk — the offline-critical test flow never pays for it.
 */

export interface ParsedRosterRow {
  /** 1-based row number in the sheet, for error messages. */
  rowNumber: number;
  name: string;
  /** Normalized YYYY-MM-DD. */
  dob: string;
  gender: 'male' | 'female' | 'other';
  guardianPhone: string;
  groundTruth: GroundTruth | null;
  groundTruthRaw: string;
  notes: string;
  /** Non-fatal issues (unmapped ground-truth label, dropped phone, ...). */
  warnings: string[];
}

export interface RosterRowError {
  rowNumber: number;
  name: string;
  errors: string[];
}

export interface RosterParseResult {
  valid: ParsedRosterRow[];
  invalid: RosterRowError[];
  /** Header columns we expected but did not find. */
  missingColumns: string[];
}

type RosterField = 'name' | 'dob' | 'gender' | 'guardianPhone' | 'groundTruth' | 'notes';

/** normalized header text -> field. Normalization strips everything non-alphanumeric. */
const HEADER_LOOKUP: Record<string, RosterField> = {
  name: 'name',
  childname: 'name',
  patientname: 'name',
  dob: 'dob',
  dateofbirth: 'dob',
  dobyyyymmdd: 'dob',
  gender: 'gender',
  sex: 'gender',
  guardianphone: 'guardianPhone',
  guardianphoneoptional: 'guardianPhone',
  phone: 'guardianPhone',
  phonenumber: 'guardianPhone',
  contact: 'guardianPhone',
  groundtruth: 'groundTruth',
  groundtruthoptional: 'groundTruth',
  diagnosis: 'groundTruth',
  label: 'groundTruth',
  notes: 'notes',
  notesoptional: 'notes',
  remarks: 'notes',
};

const REQUIRED_FIELDS: RosterField[] = ['name', 'dob', 'gender'];

const normalizeHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

// Excel serial day 0 is 1899-12-30 (accounting for the fictional 1900 leap day).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

const toIsoDate = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Normalize a DOB cell (Date, Excel serial, or common string formats) to YYYY-MM-DD. */
function normalizeDob(value: unknown): string {
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === 'number' && value > 0 && value < 200000) {
    return toIsoDate(new Date(EXCEL_EPOCH_MS + Math.round(value) * 86_400_000));
  }
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const [y, m, d] = text.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // DD/MM/YYYY or DD-MM-YYYY (Indian convention — day first).
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return text;
}

/** Accepted spellings -> canonical gender. Unknown text falls through to the zod error. */
const GENDER_SYNONYMS: Record<string, 'male' | 'female' | 'other'> = {
  male: 'male',
  m: 'male',
  boy: 'male',
  boys: 'male',
  b: 'male',
  man: 'male',
  men: 'male',
  female: 'female',
  f: 'female',
  girl: 'female',
  girls: 'female',
  g: 'female',
  woman: 'female',
  women: 'female',
  w: 'female',
  other: 'other',
  others: 'other',
  o: 'other',
};

function normalizeGender(value: string): string {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return GENDER_SYNONYMS[text] ?? text;
}

/** Flatten an exceljs cell value (richText, hyperlink, formula result, ...) to a string. */
function cellToString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return obj.richText.map(part => (part as { text?: string }).text ?? '').join('');
    }
    if (obj.text != null) return String(obj.text);
    if (obj.result != null) return cellToString(obj.result);
    return '';
  }
  return String(value);
}

interface RawRow {
  rowNumber: number;
  cells: Partial<Record<RosterField, unknown>>;
}

function mapHeaderRow(headers: unknown[]): {
  columns: Map<number, RosterField>;
  missing: string[];
} {
  const columns = new Map<number, RosterField>();
  headers.forEach((header, index) => {
    const field = HEADER_LOOKUP[normalizeHeader(cellToString(header))];
    if (field && ![...columns.values()].includes(field)) columns.set(index, field);
  });
  const found = new Set(columns.values());
  const missing = REQUIRED_FIELDS.filter(f => !found.has(f)).map(f =>
    f === 'dob' ? 'DOB' : f.charAt(0).toUpperCase() + f.slice(1)
  );
  return { columns, missing };
}

async function readXlsxRows(file: File): Promise<{ headers: unknown[]; rows: RawRow[] }> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The file has no worksheets');

  const headers: unknown[] = [];
  const rows: RawRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cell.value;
    });
    if (rowNumber === 1) headers.push(...values);
    else rows.push({ rowNumber, cells: values as never });
  });
  return { headers, rows };
}

/** Minimal RFC-4180-ish CSV parse — quoted fields, embedded commas and quotes. */
function parseCsvText(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      out.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

async function readCsvRows(file: File): Promise<{ headers: unknown[]; rows: RawRow[] }> {
  const grid = parseCsvText(await file.text());
  const [headers = [], ...rest] = grid;
  return {
    headers,
    rows: rest.map((cells, index) => ({ rowNumber: index + 2, cells: cells as never })),
  };
}

export async function parseRosterFile(file: File): Promise<RosterParseResult> {
  const isCsv = /\.csv$/i.test(file.name);
  const { headers, rows } = isCsv ? await readCsvRows(file) : await readXlsxRows(file);
  const { columns, missing } = mapHeaderRow(headers);

  if (missing.length > 0) {
    return { valid: [], invalid: [], missingColumns: missing };
  }

  const valid: ParsedRosterRow[] = [];
  const invalid: RosterRowError[] = [];

  for (const raw of rows) {
    const get = (field: RosterField): unknown => {
      for (const [index, mapped] of columns) {
        if (mapped === field) return (raw.cells as unknown[])[index];
      }
      return undefined;
    };

    const nameText = cellToString(get('name')).trim();
    const dobCell = get('dob');
    const genderText = cellToString(get('gender'));
    const phoneText = cellToString(get('guardianPhone'));
    const groundTruthText = cellToString(get('groundTruth')).trim();
    const notesText = cellToString(get('notes')).trim();

    // Trailing empty rows (or fully blank lines) are not errors.
    if (!nameText && !cellToString(dobCell).trim() && !genderText.trim()) continue;

    const parsed = campRosterRowSchema.safeParse({
      name: nameText,
      dob: normalizeDob(dobCell),
      gender: normalizeGender(genderText),
      guardianPhone: phoneText,
      groundTruthRaw: groundTruthText,
      notes: notesText,
    });

    if (!parsed.success) {
      invalid.push({
        rowNumber: raw.rowNumber,
        name: nameText || '(no name)',
        errors: parsed.error.issues.map(issue => issue.message),
      });
      continue;
    }

    const warnings: string[] = [];
    const { groundTruth, warning } = buildRosterGroundTruth(parsed.data.groundTruthRaw);
    if (warning) warnings.push(warning);

    valid.push({
      rowNumber: raw.rowNumber,
      name: parsed.data.name,
      dob: parsed.data.dob,
      gender: parsed.data.gender,
      guardianPhone: parsed.data.guardianPhone,
      groundTruth,
      groundTruthRaw: parsed.data.groundTruthRaw,
      notes: parsed.data.notes,
      warnings,
    });
  }

  return { valid, invalid, missingColumns: [] };
}

export const ROSTER_TEMPLATE_HEADERS = [
  'Name',
  'DOB (YYYY-MM-DD)',
  'Gender',
  'Guardian Phone (optional)',
  'Ground Truth (optional)',
  'Notes (optional)',
] as const;

/** How many data rows get in-sheet validation (dropdowns, date checks). */
const TEMPLATE_VALIDATED_ROWS = 500;

export async function downloadRosterTemplate(): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();

  const roster = workbook.addWorksheet('Roster');
  roster.addRow([...ROSTER_TEMPLATE_HEADERS]);
  roster.getRow(1).font = { bold: true };
  // Obviously-fake example rows — must never look like real children.
  roster.addRow([
    'Lorem Ipsum',
    '2020-03-14',
    'male',
    '+911234567890',
    'ASD',
    'Example row - replace with real data',
  ]);
  roster.addRow(['Dolor Sit Amet', '2021-07-02', 'female', '', 'No Concerns', 'Example row']);
  roster.columns.forEach(column => {
    column.width = 24;
  });
  // ISO date display for the DOB column so date-typed cells render as the
  // header promises.
  roster.getColumn(2).numFmt = 'yyyy-mm-dd';

  const allowed = workbook.addWorksheet('Allowed Values');
  allowed.addRow(['Gender', 'Ground Truth']);
  allowed.getRow(1).font = { bold: true };
  const genders = ['male', 'female', 'other'];
  const maxRows = Math.max(genders.length, ROSTER_GROUND_TRUTH_LABELS.length);
  for (let i = 0; i < maxRows; i++) {
    allowed.addRow([genders[i] ?? '', ROSTER_GROUND_TRUTH_LABELS[i] ?? '']);
  }
  allowed.addRow([]);
  allowed.addRow(['Multiple ground-truth labels can be combined with ";" e.g. "ADHD; Epilepsy"']);
  allowed.addRow([
    'Gender spellings like M / F, Boy / Girl, Man / Woman, Others are accepted at import.',
  ]);
  allowed.columns.forEach(column => {
    column.width = 34;
  });

  // In-sheet validation: catch bad data while the coordinator is typing, not
  // at import time. Excel has no date-picker control in a plain sheet, so the
  // DOB column gets the standard equivalent — a date-type validation rule plus
  // ISO formatting.
  const gtLastRow = 1 + ROSTER_GROUND_TRUTH_LABELS.length;
  for (let row = 2; row <= TEMPLATE_VALIDATED_ROWS + 1; row++) {
    roster.getCell(`A${row}`).dataValidation = {
      type: 'textLength',
      operator: 'lessThanOrEqual',
      formulae: [100],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Name too long',
      error: 'Names can be at most 100 characters.',
      promptTitle: 'Name',
      prompt: "Child's full name (letters, numbers, spaces and - , ' ( ) & only).",
    };
    roster.getCell(`B${row}`).dataValidation = {
      type: 'date',
      operator: 'between',
      formulae: [new Date(1900, 0, 1), new Date()],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid date of birth',
      error: 'Enter a real date between 1900 and today, formatted YYYY-MM-DD.',
      promptTitle: 'Date of birth',
      prompt: 'Type as YYYY-MM-DD, e.g. 2020-03-14.',
    };
    roster.getCell(`C${row}`).dataValidation = {
      type: 'list',
      formulae: ['"male,female,other"'],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid gender',
      error: 'Pick male, female or other from the dropdown.',
      promptTitle: 'Gender',
      prompt: 'Pick from the dropdown.',
    };
    roster.getCell(`D${row}`).dataValidation = {
      type: 'textLength',
      operator: 'lessThanOrEqual',
      formulae: [16],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid phone',
      error: 'Use digits only, with an optional leading +, e.g. +919876543210.',
      promptTitle: 'Guardian phone (optional)',
      prompt: 'Digits with optional leading +, e.g. +919876543210.',
    };
    roster.getCell(`E${row}`).dataValidation = {
      type: 'list',
      formulae: [`'Allowed Values'!$B$2:$B$${gtLastRow}`],
      allowBlank: true,
      showErrorMessage: true,
      // Warning, not stop: combined labels like "ADHD; Epilepsy" are valid on
      // import but can't be expressed in a single-select dropdown.
      errorStyle: 'warning',
      errorTitle: 'Not a standard label',
      error:
        'Pick a label from the dropdown, or combine several with ";" (e.g. "ADHD; Epilepsy"). ' +
        'Unrecognized text is imported as notes.',
      promptTitle: 'Ground truth (optional)',
      prompt: 'Pick from the dropdown, or combine labels with ";".',
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'camp-roster-template.xlsx';
  anchor.click();
  URL.revokeObjectURL(url);
}
