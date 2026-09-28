/**
 * Client for any OpenAI-compatible `/embeddings` endpoint (OpenAI, OpenRouter,
 * a local Ollama or vLLM server). Batches by an approximate token budget and
 * runs a few batches in parallel, like OpenClaw's indexer.
 */

export const DEFAULT_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small";

const BATCH_MAX_CHARS = 32_000; // ~8k tokens
const BATCH_MAX_INPUTS = 96;
const CONCURRENCY = 4;

export interface EmbeddingsConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EmbeddingsClient {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function batchTexts(texts: string[], maxChars = BATCH_MAX_CHARS, maxInputs = BATCH_MAX_INPUTS): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let size = 0;
  texts.forEach((text, index) => {
    if (current.length > 0 && (size + text.length > maxChars || current.length >= maxInputs)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(index);
    size += text.length;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

export function createEmbeddingsClient(config: EmbeddingsConfig, fetchImpl: FetchLike): EmbeddingsClient {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/embeddings`;

  async function embedBatch(inputs: string[]): Promise<number[][]> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Embeddings request failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    const rows = payload.data ?? [];
    if (rows.length !== inputs.length) {
      throw new Error(`Embeddings response had ${rows.length} vectors for ${inputs.length} inputs`);
    }
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => {
      if (!Array.isArray(row.embedding)) throw new Error("Embeddings response is missing a vector");
      return row.embedding.map(Number);
    });
  }

  return {
    model: config.model,
    async embed(texts) {
      const results: number[][] = new Array(texts.length);
      const batches = batchTexts(texts);
      let cursor = 0;
      const worker = async () => {
        while (cursor < batches.length) {
          const batch = batches[cursor++]!;
          const vectors = await embedBatch(batch.map((i) => texts[i]!));
          batch.forEach((textIndex, position) => {
            results[textIndex] = vectors[position]!;
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
      return results;
    },
  };
}
