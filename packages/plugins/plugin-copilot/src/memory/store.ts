import { createHash, randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { chunkMarkdown } from "./chunker.js";
import type { EmbeddingsClient } from "./embeddings.js";
import {
  MAX_DOCUMENT_CHARS,
  normalizeMemoryPath,
  noteDateFromPath,
  scopeKey,
  type MemoryScope,
  type MemoryScopeKind,
} from "./paths.js";
import {
  CANDIDATE_MULTIPLIER,
  cosineSimilarity,
  mergeHybrid,
  mmrSelect,
  normalizeTextScores,
  snippet,
  type MemoryCandidate,
} from "./ranking.js";

export interface MemoryDocument {
  id: string;
  companyId: string;
  scope: MemoryScope;
  path: string;
  body: string;
  contentHash: string;
  noteDate: string | null;
  updatedAt: string;
}

export interface MemoryActor {
  kind: "user" | "agent" | "system";
  id: string | null;
}

export interface MemorySearchResult {
  path: string;
  scope: MemoryScope;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  vectorScore: number;
  textScore: number;
  noteDate: string | null;
}

/** Embedded Postgres in local dev has no pgvector; fall back to cosine in JS over this many chunks. */
const JS_VECTOR_SCAN_LIMIT = 5_000;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function table(db: PluginDatabaseClient, name: string): string {
  return `${db.namespace}.${name}`;
}

/** Scope filter parameter: a JSON array of `kind:id` keys, matched with jsonb_array_elements_text. */
function scopeFilterParam(scopes: MemoryScope[]): string {
  return JSON.stringify(scopes.map(scopeKey));
}

/** Postgres array literal for a real[] parameter, e.g. `{0.1,0.2}`. */
function realArrayLiteral(vector: readonly number[]): string {
  return `{${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}}`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

/** Timestamps are selected as epoch milliseconds (see UPDATED_AT_MS) to avoid driver text formats. */
const UPDATED_AT_MS = "(extract(epoch from updated_at) * 1000)::float8 AS updated_at";

function toIso(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(Number(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function parseRealArray(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string" && value.startsWith("{")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map(Number) : [];
  }
  return null;
}

interface DocumentRow {
  id: string;
  company_id: string;
  scope_kind: MemoryScopeKind;
  scope_id: string;
  path: string;
  body: string;
  content_hash: string;
  note_date: string | null;
  updated_at: string | number | Date;
}

function toDocument(row: DocumentRow): MemoryDocument {
  return {
    id: row.id,
    companyId: row.company_id,
    scope: { kind: row.scope_kind, id: row.scope_id },
    path: row.path,
    body: row.body,
    contentHash: row.content_hash,
    noteDate: row.note_date,
    updatedAt: toIso(row.updated_at),
  };
}

const DOCUMENT_COLUMNS = `id, company_id, scope_kind, scope_id, path, body, content_hash,
  note_date::text AS note_date, ${UPDATED_AT_MS}`;

export async function getDocument(
  db: PluginDatabaseClient,
  companyId: string,
  scope: MemoryScope,
  path: string,
): Promise<MemoryDocument | null> {
  const rows = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS}
       FROM ${table(db, "memory_documents")}
      WHERE company_id = $1 AND scope_kind = $2 AND scope_id = $3 AND path = $4`,
    [companyId, scope.kind, scope.id, normalizeMemoryPath(path)],
  );
  return rows[0] ? toDocument(rows[0]) : null;
}

export interface MemoryDocumentSummary {
  scope: MemoryScope;
  path: string;
  chars: number;
  noteDate: string | null;
  updatedAt: string;
}

export async function listDocuments(
  db: PluginDatabaseClient,
  companyId: string,
  scopes: MemoryScope[],
): Promise<MemoryDocumentSummary[]> {
  if (scopes.length === 0) return [];
  const rows = await db.query<{
    scope_kind: MemoryScopeKind;
    scope_id: string;
    path: string;
    chars: number | string;
    note_date: string | null;
    updated_at: string | number | Date;
  }>(
    `SELECT scope_kind, scope_id, path, length(body) AS chars, note_date::text AS note_date, ${UPDATED_AT_MS}
       FROM ${table(db, "memory_documents")}
      WHERE company_id = $1
        AND (scope_kind || ':' || scope_id) IN (SELECT jsonb_array_elements_text($2::jsonb))
      ORDER BY scope_kind, scope_id, note_date DESC NULLS FIRST, path`,
    [companyId, scopeFilterParam(scopes)],
  );
  return rows.map((row) => ({
    scope: { kind: row.scope_kind, id: row.scope_id },
    path: row.path,
    chars: Number(row.chars),
    noteDate: row.note_date,
    updatedAt: toIso(row.updated_at),
  }));
}

/**
 * Everything a board user may browse: company memory, every agent's memory,
 * and only their own personal (user) memory.
 */
export async function listBrowsableDocuments(
  db: PluginDatabaseClient,
  companyId: string,
  userId: string | null,
): Promise<MemoryDocumentSummary[]> {
  const rows = await db.query<{
    scope_kind: MemoryScopeKind;
    scope_id: string;
    path: string;
    chars: number | string;
    note_date: string | null;
    updated_at: string | number | Date;
  }>(
    `SELECT scope_kind, scope_id, path, length(body) AS chars, note_date::text AS note_date, ${UPDATED_AT_MS}
       FROM ${table(db, "memory_documents")}
      WHERE company_id = $1
        AND (scope_kind IN ('company', 'agent') OR (scope_kind = 'user' AND scope_id = $2))
      ORDER BY scope_kind, scope_id, note_date DESC NULLS FIRST, path`,
    [companyId, userId ?? ""],
  );
  return rows.map((row) => ({
    scope: { kind: row.scope_kind, id: row.scope_id },
    path: row.path,
    chars: Number(row.chars),
    noteDate: row.note_date,
    updatedAt: toIso(row.updated_at),
  }));
}

export async function indexStatus(
  db: PluginDatabaseClient,
  companyId: string,
): Promise<{ documents: number; pending: number; chunks: number; embeddedChunks: number }> {
  const rows = await db.query<{ documents: string; pending: string; chunks: string; embedded: string }>(
    `SELECT
       (SELECT count(*) FROM ${table(db, "memory_documents")} WHERE company_id = $1)::text AS documents,
       (SELECT count(*) FROM ${table(db, "memory_documents")}
         WHERE company_id = $1 AND indexed_hash IS DISTINCT FROM content_hash)::text AS pending,
       (SELECT count(*) FROM ${table(db, "memory_chunks")} WHERE company_id = $1)::text AS chunks,
       (SELECT count(*) FROM ${table(db, "memory_chunks")}
         WHERE company_id = $1 AND embedding IS NOT NULL)::text AS embedded`,
    [companyId],
  );
  const row = rows[0];
  return {
    documents: Number(row?.documents ?? 0),
    pending: Number(row?.pending ?? 0),
    chunks: Number(row?.chunks ?? 0),
    embeddedChunks: Number(row?.embedded ?? 0),
  };
}

/**
 * Replaces a document body, keeping the previous body as a revision. Returns
 * the stored document; unchanged content is a no-op.
 */
export async function writeDocument(
  db: PluginDatabaseClient,
  input: {
    companyId: string;
    scope: MemoryScope;
    path: string;
    body: string;
    actor: MemoryActor;
    reason?: string;
  },
): Promise<MemoryDocument> {
  const path = normalizeMemoryPath(input.path);
  if (input.body.length > MAX_DOCUMENT_CHARS) {
    throw new Error(`Memory document exceeds ${MAX_DOCUMENT_CHARS} characters; consolidate it first`);
  }
  const contentHash = sha256(input.body);
  const existing = await getDocument(db, input.companyId, input.scope, path);
  if (existing?.contentHash === contentHash) return existing;

  if (existing) {
    await db.execute(
      `INSERT INTO ${table(db, "memory_document_revisions")}
         (id, document_id, company_id, body, content_hash, actor_kind, actor_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        existing.id,
        input.companyId,
        existing.body,
        existing.contentHash,
        input.actor.kind,
        input.actor.id,
        input.reason ?? null,
      ],
    );
    await db.execute(
      `UPDATE ${table(db, "memory_documents")}
          SET body = $2, content_hash = $3, updated_by_kind = $4, updated_by_id = $5, updated_at = now()
        WHERE id = $1`,
      [existing.id, input.body, contentHash, input.actor.kind, input.actor.id],
    );
  } else {
    await db.execute(
      `INSERT INTO ${table(db, "memory_documents")}
         (id, company_id, scope_kind, scope_id, path, body, content_hash, note_date, updated_by_kind, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
       ON CONFLICT (company_id, scope_kind, scope_id, path) DO NOTHING`,
      [
        randomUUID(),
        input.companyId,
        input.scope.kind,
        input.scope.id,
        path,
        input.body,
        contentHash,
        noteDateFromPath(path),
        input.actor.kind,
        input.actor.id,
      ],
    );
  }
  const stored = await getDocument(db, input.companyId, input.scope, path);
  if (!stored) throw new Error(`Memory document ${path} could not be written`);
  return stored;
}

/** Appends a line (or block) to a document, creating it when missing. */
export async function appendToDocument(
  db: PluginDatabaseClient,
  input: {
    companyId: string;
    scope: MemoryScope;
    path: string;
    text: string;
    actor: MemoryActor;
    header?: string;
  },
): Promise<MemoryDocument> {
  const existing = await getDocument(db, input.companyId, input.scope, input.path);
  const base = existing?.body ?? (input.header ? `${input.header}\n` : "");
  const separator = base === "" || base.endsWith("\n") ? "" : "\n";
  return writeDocument(db, {
    companyId: input.companyId,
    scope: input.scope,
    path: input.path,
    body: `${base}${separator}${input.text.trimEnd()}\n`,
    actor: input.actor,
    reason: "append",
  });
}

export async function deleteDocument(
  db: PluginDatabaseClient,
  companyId: string,
  scope: MemoryScope,
  path: string,
): Promise<boolean> {
  const result = await db.execute(
    `DELETE FROM ${table(db, "memory_documents")}
      WHERE company_id = $1 AND scope_kind = $2 AND scope_id = $3 AND path = $4`,
    [companyId, scope.kind, scope.id, normalizeMemoryPath(path)],
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

async function embedWithCache(
  db: PluginDatabaseClient,
  embeddings: EmbeddingsClient,
  texts: string[],
): Promise<number[][]> {
  const hashes = texts.map(sha256);
  const cached = new Map<string, number[]>();
  if (hashes.length > 0) {
    const rows = await db.query<{ content_hash: string; embedding: unknown }>(
      `SELECT content_hash, embedding
         FROM ${table(db, "embedding_cache")}
        WHERE model = $1 AND content_hash IN (SELECT jsonb_array_elements_text($2::jsonb))`,
      [embeddings.model, JSON.stringify([...new Set(hashes)])],
    );
    for (const row of rows) {
      const vector = parseRealArray(row.embedding);
      if (vector) cached.set(row.content_hash, vector);
    }
  }
  const missing = [...new Set(hashes.filter((hash) => !cached.has(hash)))];
  if (missing.length > 0) {
    const missingTexts = missing.map((hash) => texts[hashes.indexOf(hash)]!);
    const vectors = await embeddings.embed(missingTexts);
    for (let i = 0; i < missing.length; i += 1) {
      cached.set(missing[i]!, vectors[i]!);
      await db.execute(
        `INSERT INTO ${table(db, "embedding_cache")} (content_hash, model, embedding)
         VALUES ($1, $2, $3::real[])
         ON CONFLICT (content_hash, model) DO NOTHING`,
        [missing[i], embeddings.model, realArrayLiteral(vectors[i]!)],
      );
    }
  }
  return hashes.map((hash) => cached.get(hash)!);
}

/**
 * Rebuilds the chunk index for one document. Embedding failures degrade to a
 * keyword-only index for that document rather than failing the write.
 */
export async function indexDocument(
  db: PluginDatabaseClient,
  document: MemoryDocument,
  embeddings: EmbeddingsClient | null,
  onEmbeddingError?: (error: unknown) => void,
): Promise<number> {
  const chunks = chunkMarkdown(document.body);
  let vectors: Array<number[] | null> = chunks.map(() => null);
  if (embeddings && chunks.length > 0) {
    try {
      vectors = await embedWithCache(db, embeddings, chunks.map((chunk) => chunk.text));
    } catch (error) {
      onEmbeddingError?.(error);
    }
  }

  await db.execute(`DELETE FROM ${table(db, "memory_chunks")} WHERE document_id = $1`, [document.id]);
  for (const [i, chunk] of chunks.entries()) {
    const vector = vectors[i];
    await db.execute(
      `INSERT INTO ${table(db, "memory_chunks")}
         (id, document_id, company_id, scope_kind, scope_id, chunk_index, start_line, end_line, text, tsv, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_tsvector('english', $10), $11::real[], $12)`,
      [
        randomUUID(),
        document.id,
        document.companyId,
        document.scope.kind,
        document.scope.id,
        chunk.index,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        `${document.path}\n${chunk.text}`,
        vector ? realArrayLiteral(vector) : null,
        vector && embeddings ? embeddings.model : null,
      ],
    );
  }
  await db.execute(
    `UPDATE ${table(db, "memory_documents")} SET indexed_hash = $2 WHERE id = $1 AND content_hash = $2`,
    [document.id, document.contentHash],
  );
  return chunks.length;
}

/** Indexes documents whose content changed since they were last indexed. */
export async function reindexPending(
  db: PluginDatabaseClient,
  resolveEmbeddings: (companyId: string) => Promise<EmbeddingsClient | null>,
  options: { limit?: number; onEmbeddingError?: (companyId: string, error: unknown) => void } = {},
): Promise<number> {
  const rows = await db.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS}
       FROM ${table(db, "memory_documents")}
      WHERE indexed_hash IS DISTINCT FROM content_hash
      ORDER BY updated_at
      LIMIT $1`,
    [options.limit ?? 50],
  );
  const clients = new Map<string, EmbeddingsClient | null>();
  for (const row of rows) {
    const document = toDocument(row);
    if (!clients.has(document.companyId)) {
      clients.set(document.companyId, await resolveEmbeddings(document.companyId).catch(() => null));
    }
    await indexDocument(db, document, clients.get(document.companyId) ?? null, (error) =>
      options.onEmbeddingError?.(document.companyId, error),
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let vectorExtensionAvailable: boolean | null = null;

/** Whether pgvector is installed; checked once per worker. */
export async function hasVectorExtension(db: PluginDatabaseClient): Promise<boolean> {
  if (vectorExtensionAvailable === null) {
    const rows = await db
      .query<{ available: boolean }>(`SELECT to_regtype('vector') IS NOT NULL AS available`)
      .catch(() => [{ available: false }]);
    vectorExtensionAvailable = rows[0]?.available === true;
  }
  return vectorExtensionAvailable;
}

/** Test seam: forget the cached pgvector probe. */
export function resetVectorExtensionProbe(): void {
  vectorExtensionAvailable = null;
}

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  path: string;
  scope_kind: string;
  scope_id: string;
  note_date: string | null;
  start_line: number;
  end_line: number;
  text: string;
}

function toCandidate(row: ChunkRow): MemoryCandidate {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    path: row.path,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    noteDate: row.note_date,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    text: row.text,
  };
}

const CHUNK_COLUMNS = `c.id AS chunk_id, c.document_id, d.path, c.scope_kind, c.scope_id,
  d.note_date::text AS note_date, c.start_line, c.end_line, c.text`;

async function keywordSearch(
  db: PluginDatabaseClient,
  companyId: string,
  scopes: MemoryScope[],
  query: string,
  limit: number,
) {
  // OR the query terms: recall first, and ts_rank_cd still rewards chunks
  // matching more of them.
  const rows = await db.query<ChunkRow & { rank: number | string }>(
    `SELECT ${CHUNK_COLUMNS}, ts_rank_cd(c.tsv, q.query) AS rank
       FROM ${table(db, "memory_chunks")} c
       JOIN ${table(db, "memory_documents")} d ON d.id = c.document_id
      CROSS JOIN (
        SELECT nullif(replace(plainto_tsquery('english', $2)::text, '&', '|'), '')::tsquery AS query
      ) q
      WHERE c.company_id = $1
        AND q.query IS NOT NULL
        AND (c.scope_kind || ':' || c.scope_id) IN (SELECT jsonb_array_elements_text($3::jsonb))
        AND c.tsv @@ q.query
      ORDER BY rank DESC
      LIMIT $4`,
    [companyId, query, scopeFilterParam(scopes), limit],
  );
  return normalizeTextScores(rows.map((row) => ({ ...toCandidate(row), rank: Number(row.rank) })));
}

async function vectorSearch(
  db: PluginDatabaseClient,
  companyId: string,
  scopes: MemoryScope[],
  queryVector: number[],
  model: string,
  limit: number,
) {
  if (await hasVectorExtension(db)) {
    const rows = await db.query<ChunkRow & { similarity: number | string }>(
      `SELECT ${CHUNK_COLUMNS}, 1 - (c.embedding::vector <=> $2::vector) AS similarity
         FROM ${table(db, "memory_chunks")} c
         JOIN ${table(db, "memory_documents")} d ON d.id = c.document_id
        WHERE c.company_id = $1
          AND c.embedding IS NOT NULL
          AND c.embedding_model = $3
          AND (c.scope_kind || ':' || c.scope_id) IN (SELECT jsonb_array_elements_text($4::jsonb))
        ORDER BY c.embedding::vector <=> $2::vector
        LIMIT $5`,
      [companyId, vectorLiteral(queryVector), model, scopeFilterParam(scopes), limit],
    );
    return rows.map((row) => ({ ...toCandidate(row), vectorScore: Math.max(0, Number(row.similarity)) }));
  }

  const rows = await db.query<ChunkRow & { embedding: unknown }>(
    `SELECT ${CHUNK_COLUMNS}, c.embedding
       FROM ${table(db, "memory_chunks")} c
       JOIN ${table(db, "memory_documents")} d ON d.id = c.document_id
      WHERE c.company_id = $1
        AND c.embedding IS NOT NULL
        AND c.embedding_model = $2
        AND (c.scope_kind || ':' || c.scope_id) IN (SELECT jsonb_array_elements_text($3::jsonb))
      ORDER BY d.updated_at DESC
      LIMIT $4`,
    [companyId, model, scopeFilterParam(scopes), JS_VECTOR_SCAN_LIMIT],
  );
  return rows
    .map((row) => ({
      ...toCandidate(row),
      vectorScore: Math.max(0, cosineSimilarity(queryVector, parseRealArray(row.embedding) ?? [])),
    }))
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, limit);
}

export interface MemorySearchOptions {
  companyId: string;
  scopes: MemoryScope[];
  query: string;
  topK?: number;
  embeddings?: EmbeddingsClient | null;
  now?: Date;
  onEmbeddingError?: (error: unknown) => void;
}

export async function searchMemory(
  db: PluginDatabaseClient,
  options: MemorySearchOptions,
): Promise<{ results: MemorySearchResult[]; mode: "hybrid" | "keyword" }> {
  const query = options.query.trim();
  const topK = Math.min(Math.max(options.topK ?? 6, 1), 20);
  if (!query || options.scopes.length === 0) return { results: [], mode: "keyword" };
  const candidateLimit = topK * CANDIDATE_MULTIPLIER;

  let vectorHits: Awaited<ReturnType<typeof vectorSearch>> = [];
  let vectorEnabled = false;
  if (options.embeddings) {
    try {
      const [queryVector] = await options.embeddings.embed([query]);
      if (queryVector) {
        vectorHits = await vectorSearch(
          db,
          options.companyId,
          options.scopes,
          queryVector,
          options.embeddings.model,
          candidateLimit,
        );
        vectorEnabled = true;
      }
    } catch (error) {
      options.onEmbeddingError?.(error);
    }
  }
  const textHits = await keywordSearch(db, options.companyId, options.scopes, query, candidateLimit);

  const merged = mergeHybrid(vectorHits, textHits, { vectorEnabled, now: options.now ?? new Date() });
  const selected = mmrSelect(
    merged.filter((candidate) => candidate.score > 0),
    topK,
  );
  return {
    mode: vectorEnabled ? "hybrid" : "keyword",
    results: selected.map((candidate) => ({
      path: candidate.path,
      scope: { kind: candidate.scopeKind as MemoryScopeKind, id: candidate.scopeId },
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: snippet(candidate.text),
      score: Number(candidate.score.toFixed(4)),
      vectorScore: Number(candidate.vectorScore.toFixed(4)),
      textScore: Number(candidate.textScore.toFixed(4)),
      noteDate: candidate.noteDate,
    })),
  };
}
