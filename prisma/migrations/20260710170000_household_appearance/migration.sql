-- Add a household-wide curated appearance preset.
ALTER TABLE "HouseholdSettings"
  ADD COLUMN "accentTheme" TEXT NOT NULL DEFAULT 'sage';
