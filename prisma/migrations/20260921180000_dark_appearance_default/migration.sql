BEGIN;

-- Cubby now opens dark, with Light and System offered to whoever wants them.
--
-- Only the default for accounts created from here on. Every existing account holds "system", given to
-- it by the previous default, and there is no way to tell that apart from someone who deliberately
-- chose to follow their device - so those rows are left exactly as they are. Anyone who wants dark
-- picks it in Settings, once.
ALTER TABLE "User" ALTER COLUMN "appearanceMode" SET DEFAULT 'dark'::"AppearanceMode";

COMMIT;
