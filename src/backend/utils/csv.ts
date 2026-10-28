import { ExportResultRow } from '../types/domain.ts';

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralizes spreadsheet formula injection (CSV injection) on untrusted text values
 * and applies RFC-4180 CSV double-quote escaping.
 */
export function sanitizeCsvCell(value: unknown, treatAsText = true): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (!treatAsText && typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  let str = String(value);

  if (treatAsText && str.length > 0) {
    const firstChar = str[0];
    const trimmedFirstChar = str.trimStart()[0];
    if (
      FORMULA_TRIGGER_CHARS.has(firstChar) ||
      (trimmedFirstChar !== undefined && FORMULA_TRIGGER_CHARS.has(trimmedFirstChar))
    ) {
      str = `'${str}`;
    }
  }

  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function formatExamResultsCsv(rows: ExportResultRow[]): string {
  const headers = [
    'Student Name',
    'Student Identifier',
    'Student Email',
    'Examination Title',
    'Attempt Number',
    'Attempt Status',
    'Started At (UTC)',
    'Submitted At (UTC)',
    'Time Taken (Seconds)',
    'Marks Obtained',
    'Total Marks',
    'Percentage (%)',
    'Pass/Fail',
  ];

  const lines: string[] = [headers.map((h) => sanitizeCsvCell(h, true)).join(',')];

  for (const row of rows) {
    const cells = [
      sanitizeCsvCell(row.student_name, true),
      sanitizeCsvCell(row.student_identifier, true),
      sanitizeCsvCell(row.student_email, true),
      sanitizeCsvCell(row.exam_title, true),
      sanitizeCsvCell(Number(row.attempt_number), false),
      sanitizeCsvCell(row.attempt_status, true),
      sanitizeCsvCell(row.started_at ?? '', true),
      sanitizeCsvCell(row.submitted_at ?? '', true),
      row.time_taken_seconds !== null && row.time_taken_seconds !== undefined
        ? sanitizeCsvCell(Number(row.time_taken_seconds), false)
        : '',
      row.marks_obtained !== null && row.marks_obtained !== undefined
        ? sanitizeCsvCell(Number(row.marks_obtained), false)
        : '',
      row.total_marks !== null && row.total_marks !== undefined
        ? sanitizeCsvCell(Number(row.total_marks), false)
        : '',
      row.percentage !== null && row.percentage !== undefined
        ? sanitizeCsvCell(Number(row.percentage), false)
        : '',
      sanitizeCsvCell(row.pass_status, true),
    ];
    lines.push(cells.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}
