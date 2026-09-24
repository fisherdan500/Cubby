import { describe, expect, it } from "vitest";
import { neutralizeSpreadsheetFormula } from "@/lib/spreadsheet-cell";

const char = (code: number) => String.fromCharCode(code);

describe("spreadsheet formula neutralization", () => {
  it.each([
    ["equals", "=1+1"],
    ["plus", "+1+1"],
    ["minus", "-1+1"],
    ["at sign", "@SUM(A1:A2)"],
    ["a DDE payload", "=cmd|' /C calc'!A0"],
    ["a leading space", " =1+1"],
    ["several leading spaces", "   +1"],
    ["a leading tab", "\t=1+1"],
    ["a leading carriage return", "\r=1+1"],
    ["a leading line feed", "\n-1+1"],
    ["a leading CRLF", "\r\n@SUM(A1)"],
    ["a leading NUL", `${char(0)}=1+1`],
    ["a leading escape", `${char(0x1b)}=1+1`],
    ["a leading no-break space", `${char(0xa0)}=1+1`],
    ["a leading ideographic space", `${char(0x3000)}=1+1`],
    ["a leading zero-width space", `${char(0x200b)}=1+1`],
    ["a leading byte-order mark", `${char(0xfeff)}=1+1`],
    ["a full-width equals", `${char(0xff1d)}1+1`],
    ["a full-width plus", `${char(0xff0b)}1`],
    ["a full-width minus", `${char(0xff0d)}1`],
    ["a full-width at sign", `${char(0xff20)}SUM(A1)`]
  ])("prefixes a cell starting with %s so it stays literal text", (_label, value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
  });

  it.each([
    ["a bare tab", "\t"],
    ["a bare carriage return", "\r"],
    ["a leading control character before text", `${char(0x07)}hello`]
  ])("prefixes a cell starting with %s, which some spreadsheets treat as a trigger", (_label, value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
  });

  it.each([
    ["empty", ""],
    ["plain text", "Slept well"],
    ["a detail summary", "Kind: Bottle; Amount: 4 oz"],
    ["an ISO instant", "2026-09-19T14:30:00.000Z"],
    ["a number", "3600"],
    ["an operator after the first character", "a=b"],
    ["arithmetic in prose", "5 - 3 oz"],
    ["an email address", "parent@example.com"],
    ["a leading space before text", "  morning nap"],
    ["an apostrophe already", "'quoted"]
  ])("leaves %s unchanged", (_label, value) => {
    expect(neutralizeSpreadsheetFormula(value)).toBe(value);
  });
});
