import { queryAll, queryOne, execute } from '../db/query';
import { markDirty } from '../db/connection';

interface VectorEntry {
  id: number;
  fileId: number;
  chunkIndex: number;
  heading: string;
  embedding: Float64Array;
}

// In-memory vector cache for fast cosine similarity
let vectors: VectorEntry[] = [];

export function loadVectors(): number {
  const rows = queryAll<{
    id: number;
    file_id: number;
    chunk_index: number;
    heading: string;
    embedding: Uint8Array | null;
  }>('SELECT id, file_id, chunk_index, heading, embedding FROM embeddings WHERE embedding IS NOT NULL');

  vectors = rows
    .filter(row => row.embedding != null)
    .map(row => {
      // sql.js returns BLOBs as Uint8Array
      const bytes = row.embedding as Uint8Array;
      const float64 = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
      return {
        id: row.id,
        fileId: row.file_id,
        chunkIndex: row.chunk_index,
        heading: row.heading ?? '',
        embedding: new Float64Array(float64), // copy to own buffer
      };
    });

  return vectors.length;
}

export function getVectorCount(): number {
  return vectors.length;
}

export function searchVectors(queryEmbedding: number[], topK = 10): Array<{
  id: number;
  fileId: number;
  chunkIndex: number;
  heading: string;
  score: number;
}> {
  const qVec = new Float64Array(queryEmbedding);

  const scored = vectors.map(v => ({
    id: v.id,
    fileId: v.fileId,
    chunkIndex: v.chunkIndex,
    heading: v.heading,
    score: cosineSimilarity(qVec, v.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function findSimilarByFile(filePath: string, topK = 10): Array<{
  path: string;
  title: string;
  score: number;
}> {
  const file = queryOne<{ id: number }>('SELECT id FROM files WHERE path = ?', [filePath]);
  if (!file) return [];

  const fileVectors = vectors.filter(v => v.fileId === file.id);
  if (fileVectors.length === 0) return [];

  // Average embedding for the file
  const dim = fileVectors[0].embedding.length;
  const avg = new Float64Array(dim);
  for (const v of fileVectors) {
    for (let i = 0; i < dim; i++) avg[i] += v.embedding[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= fileVectors.length;

  // Score all other files
  const fileScores = new Map<number, { total: number; count: number }>();
  for (const v of vectors) {
    if (v.fileId === file.id) continue;
    const sim = cosineSimilarity(avg, v.embedding);
    const existing = fileScores.get(v.fileId) ?? { total: 0, count: 0 };
    existing.total += sim;
    existing.count++;
    fileScores.set(v.fileId, existing);
  }

  const results: Array<{ fileId: number; score: number }> = [];
  for (const [fileId, { total, count }] of fileScores) {
    results.push({ fileId, score: total / count });
  }
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, topK).map(r => {
    const f = queryOne<{ path: string; title: string }>('SELECT path, title FROM files WHERE id = ?', [r.fileId]);
    return { path: f?.path ?? '', title: f?.title ?? '', score: r.score };
  });
}

export function storeEmbedding(fileId: number, chunkIndex: number, chunkText: string, heading: string, embedding: number[]): void {
  // Convert to Float64Array then to Uint8Array for BLOB storage
  const float64 = new Float64Array(embedding);
  const bytes = new Uint8Array(float64.buffer);
  execute(
    `INSERT INTO embeddings (file_id, chunk_index, chunk_text, heading, embedding)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id, chunk_index) DO UPDATE SET
       chunk_text = excluded.chunk_text,
       heading = excluded.heading,
       embedding = excluded.embedding`,
    [fileId, chunkIndex, chunkText, heading, bytes]
  );
  markDirty();
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
