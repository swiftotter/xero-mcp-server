/**
 * Convert a YYYY-MM-DD string into a Xero `where`-clause DateTime literal,
 * e.g. "2024-01-31" -> "DateTime(2024,1,31)".
 *
 * @param iso   Date string in YYYY-MM-DD format.
 * @param label Field name used in the error message when the input is invalid.
 */
export function toXeroDateTime(iso: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new Error(`${label} must be in YYYY-MM-DD format, got "${iso}"`);
  }
  const [, y, m, d] = match;
  return `DateTime(${Number(y)},${Number(m)},${Number(d)})`;
}
