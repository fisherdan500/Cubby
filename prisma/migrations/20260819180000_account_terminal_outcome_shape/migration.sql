ALTER TABLE "AccountMutationOperation"
  ADD CONSTRAINT "AccountMutationOperation_terminal_outcome_check" CHECK (
    ("status" IN ('pending', 'unknown') AND "outcomeVersion" IS NULL AND "outcomeKind" IS NULL AND "outcomeCode" IS NULL AND "outcomeSnapshot" IS NULL AND "terminalAt" IS NULL)
    OR
    ("status" = 'completed' AND "outcomeVersion" = 2 AND "outcomeKind" IS NOT NULL AND "outcomeCode" IS NOT NULL AND "outcomeSnapshot" IS NOT NULL AND "terminalAt" IS NOT NULL)
    OR
    ("status" IN ('rejected', 'stale') AND "outcomeVersion" = 2 AND "outcomeKind" IS NOT NULL AND "outcomeCode" IS NOT NULL AND "outcomeSnapshot" IS NULL AND "terminalAt" IS NOT NULL)
  );
