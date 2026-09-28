-- Markdown memory documents, OpenClaw-style: MEMORY.md, USER.md, DREAMS.md and
-- dated daily logs (memory/YYYY-MM-DD.md), scoped to the company, one user, or
-- one agent. The document body is the source of truth; chunks are a derived
-- search index rebuilt whenever content_hash moves past indexed_hash.
CREATE TABLE plugin_copilot_8879e97898.memory_documents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('company', 'user', 'agent')),
  scope_id text NOT NULL,
  path text NOT NULL,
  body text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  -- Set for dated notes, which lose ranking weight over time; null is evergreen.
  note_date date,
  indexed_hash text,
  updated_by_kind text,
  updated_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, scope_kind, scope_id, path)
);

CREATE INDEX memory_documents_reindex_idx
  ON plugin_copilot_8879e97898.memory_documents (company_id)
  WHERE indexed_hash IS DISTINCT FROM content_hash;

-- Every write keeps the prior body, so curated edits and nightly consolidation
-- can be reviewed and undone.
CREATE TABLE plugin_copilot_8879e97898.memory_document_revisions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES plugin_copilot_8879e97898.memory_documents(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  body text NOT NULL,
  content_hash text NOT NULL,
  actor_kind text,
  actor_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_document_revisions_document_idx
  ON plugin_copilot_8879e97898.memory_document_revisions (document_id, created_at DESC);

-- Search index. Embeddings are real[] so this schema never depends on pgvector;
-- queries cast to vector only when the extension is installed.
CREATE TABLE plugin_copilot_8879e97898.memory_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES plugin_copilot_8879e97898.memory_documents(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  scope_kind text NOT NULL,
  scope_id text NOT NULL,
  chunk_index integer NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  text text NOT NULL,
  tsv tsvector NOT NULL,
  embedding real[],
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_chunks_tsv_idx
  ON plugin_copilot_8879e97898.memory_chunks USING gin (tsv);

CREATE INDEX memory_chunks_scope_idx
  ON plugin_copilot_8879e97898.memory_chunks (company_id, scope_kind, scope_id);

CREATE INDEX memory_chunks_document_idx
  ON plugin_copilot_8879e97898.memory_chunks (document_id);

-- Embeddings keyed by chunk text hash and model, so reindexing unchanged text
-- costs nothing.
CREATE TABLE plugin_copilot_8879e97898.embedding_cache (
  content_hash text NOT NULL,
  model text NOT NULL,
  embedding real[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, model)
);
