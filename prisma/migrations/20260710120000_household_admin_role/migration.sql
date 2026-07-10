-- Add delegated household administrators while keeping owners protected.
ALTER TYPE "HouseholdRole" ADD VALUE IF NOT EXISTS 'admin' AFTER 'owner';
