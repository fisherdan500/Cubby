/**
 * Spreadsheet applications evaluate a cell beginning with = + - or @ as a formula, and several skip
 * leading whitespace, invisible format characters or control characters before deciding; a leading
 * tab or carriage return is a trigger on its own in some. Full-width forms are normalized to ASCII by
 * some importers. A leading apostrophe makes such a cell literal text while keeping the value visible.
 */
const formulaAfterPadding = /^[\s\p{Cc}\p{Cf}]*[=+\-@\u{FF1D}\u{FF0B}\u{FF0D}\u{FF20}]/u;
const leadingControl = /^[\p{Cc}\p{Cf}]/u;

export function neutralizeSpreadsheetFormula(value: string) {
  return formulaAfterPadding.test(value) || leadingControl.test(value) ? `'${value}` : value;
}
