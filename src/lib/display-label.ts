export function displayLabel(value: string, emptyLabel = "None") {
  if (!value) return emptyLabel;
  return value.replace(/_/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
