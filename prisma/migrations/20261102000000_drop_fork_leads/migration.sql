-- The fork's own Startups list (20261022100000_startup_leads) is replaced by
-- Dossier's Startups (20261023084641_startups). Nothing in it was saved or
-- contacted, so it goes.
DROP TABLE IF EXISTS "Lead";
DROP TYPE IF EXISTS "LeadStatus";
