-- Enabled once when the database volume is first created. Plugins cannot run
-- CREATE EXTENSION themselves, so the operator makes pgvector available here.
CREATE EXTENSION IF NOT EXISTS vector;
