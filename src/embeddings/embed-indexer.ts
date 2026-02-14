import { queryAll, execute } from '../db/query';
import { markDirty } from '../db/connection';
import { embed, isOllamaRunning } from './ollama-client';
import { chunkMarkdown } from './chunker';
import { storeEmbedding, loadVectors } from './vector-store';
import type { EmbedResult } from '../types';

export async function runEmbedIndex(
  force = false,
  onProgress?: (pct: number, msg: string) => void
): Promise<EmbedResult> {
  const start = Date.now();

  if (!(await isOllamaRunning())) {
    throw new Error('Ollama is not running. Start with: ollama serve');
  }

  // Get files to embed
  let files: Array<{ id: number; path: string; content: string }>;
  if (force) {
    files = queryAll('SELECT id, path, content FROM files');
  } else {
    files = queryAll(
      `SELECT id, path, content FROM files
       WHERE embedded_at IS NULL OR indexed_at > embedded_at`
    );
  }

  let embedded = 0;
  let skipped = 0;
  let errors = 0;
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const chunks = chunkMarkdown(file.content);
      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      if (force) {
        execute('DELETE FROM embeddings WHERE file_id = ?', [file.id]);
      }

      for (const chunk of chunks) {
        const vector = await embed(chunk.text);
        storeEmbedding(file.id, chunk.index, chunk.text, chunk.heading, vector);
      }

      execute('UPDATE files SET embedded_at = ? WHERE id = ?', [Date.now(), file.id]);
      embedded++;

      const pct = Math.round(((i + 1) / total) * 100);
      onProgress?.(pct, file.path);
    } catch (err) {
      console.error(`[Engram] Embed error ${file.path}:`, err);
      errors++;
    }
  }

  // Reload vector cache
  loadVectors();
  markDirty();

  return { embedded, skipped, errors, durationMs: Date.now() - start };
}
