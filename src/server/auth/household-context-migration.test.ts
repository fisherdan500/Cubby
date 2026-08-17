import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function productionSources(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") return [];
      return productionSources(path);
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (/\.(test|semantic|operation)\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

function exportedFunctionBody(source: string, fileName: string, functionName: string) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );

  return declaration?.body?.getText(sourceFile) ?? "";
}

describe("effective household caller migration", () => {
  it("contains no direct production getHouseholdContext empty calls", () => {
    const offenders = productionSources().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /getHouseholdContext\s*\(\s*\)/.test(source) ? [relative(process.cwd(), file)] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps joinedAt ordering only in specialized onboarding bootstrap logic", () => {
    const householdSource = readFileSync(join(sourceRoot, "server/services/households.ts"), "utf8");
    const occurrences = householdSource.match(/orderBy:\s*\{\s*joinedAt:\s*"asc"\s*\}/g) ?? [];

    expect(occurrences).toHaveLength(1);
    expect(householdSource).toMatch(/createOnboardingHousehold[\s\S]*orderBy:\s*\{\s*joinedAt:\s*"asc"\s*\}/);
  });

  it("does not resolve household home or appearance through oldest membership ordering", () => {
    const householdFile = join(sourceRoot, "server/services/households.ts");
    const appearanceFile = join(sourceRoot, "server/services/appearance.ts");
    const householdSource = readFileSync(householdFile, "utf8");
    const appearanceSource = readFileSync(appearanceFile, "utf8");
    const homeBody = exportedFunctionBody(householdSource, householdFile, "getHouseholdHome");
    const themeBody = exportedFunctionBody(appearanceSource, appearanceFile, "getCurrentAppearanceTheme");

    expect(homeBody).not.toBe("");
    expect(themeBody).not.toBe("");
    expect(homeBody).not.toContain("joinedAt");
    expect(themeBody).not.toContain("joinedAt");
    expect(homeBody).toContain("getEffectiveHouseholdContext");
    expect(themeBody).toContain("getEffectiveHouseholdContext");
  });
});
