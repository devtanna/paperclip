/**
 * Hybrid memory ranking with OpenClaw's defaults: 0.7 vector + 0.3 keyword,
 * a 30-day half-life for dated notes (evergreen files never decay), then MMR
 * (lambda 0.7, Jaccard over snippet tokens) to drop near-duplicates.
 */

export const VECTOR_WEIGHT = 0.7;
export const TEXT_WEIGHT = 0.3;
export const DECAY_HALF_LIFE_DAYS = 30;
export const MMR_LAMBDA = 0.7;
export const SNIPPET_MAX_CHARS = 700;
export const CANDIDATE_MULTIPLIER = 4;

export interface MemoryCandidate {
  chunkId: string;
  documentId: string;
  path: string;
  scopeKind: string;
  scopeId: string;
  /** ISO date for dated notes; null is evergreen. */
  noteDate: string | null;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ScoredCandidate extends MemoryCandidate {
  vectorScore: number;
  textScore: number;
  score: number;
}

/** Normalizes raw keyword ranks into [0, 1] relative to the best hit. */
export function normalizeTextScores<T extends { rank: number }>(hits: T[]): Array<T & { textScore: number }> {
  const best = hits.reduce((max, hit) => Math.max(max, hit.rank), 0);
  return hits.map((hit) => ({ ...hit, textScore: best > 0 ? hit.rank / best : 0 }));
}

export function recencyDecay(noteDate: string | null, now: Date, halfLifeDays = DECAY_HALF_LIFE_DAYS): number {
  if (!noteDate) return 1;
  const ageMs = now.getTime() - new Date(`${noteDate}T00:00:00Z`).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Union of vector and keyword hits. Without vector search the keyword score
 * carries the full weight.
 */
export function mergeHybrid(
  vectorHits: Array<MemoryCandidate & { vectorScore: number }>,
  textHits: Array<MemoryCandidate & { textScore: number }>,
  options: { vectorEnabled: boolean; now: Date },
): ScoredCandidate[] {
  const byChunk = new Map<string, ScoredCandidate>();
  for (const hit of vectorHits) {
    byChunk.set(hit.chunkId, { ...hit, vectorScore: hit.vectorScore, textScore: 0, score: 0 });
  }
  for (const hit of textHits) {
    const existing = byChunk.get(hit.chunkId);
    if (existing) existing.textScore = hit.textScore;
    else byChunk.set(hit.chunkId, { ...hit, vectorScore: 0, textScore: hit.textScore, score: 0 });
  }
  const vectorWeight = options.vectorEnabled ? VECTOR_WEIGHT : 0;
  const textWeight = options.vectorEnabled ? TEXT_WEIGHT : 1;
  const merged = [...byChunk.values()];
  for (const candidate of merged) {
    const relevance = vectorWeight * candidate.vectorScore + textWeight * candidate.textScore;
    candidate.score = relevance * recencyDecay(candidate.noteDate, options.now);
  }
  return merged.sort((a, b) => b.score - a.score);
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Maximal marginal relevance over already-scored candidates. */
export function mmrSelect(candidates: ScoredCandidate[], k: number, lambda = MMR_LAMBDA): ScoredCandidate[] {
  const pool = candidates.slice(0, 400).map((candidate) => ({ candidate, tokens: tokenSet(candidate.text) }));
  const topScore = pool.reduce((max, entry) => Math.max(max, entry.candidate.score), 0) || 1;
  const selected: typeof pool = [];
  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i += 1) {
      const entry = pool[i]!;
      const redundancy = selected.reduce((max, chosen) => Math.max(max, jaccard(entry.tokens, chosen.tokens)), 0);
      const value = lambda * (entry.candidate.score / topScore) - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected.map((entry) => entry.candidate);
}

export function snippet(text: string, maxChars = SNIPPET_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}
