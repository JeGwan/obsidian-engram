import type { App, TFile } from 'obsidian';
import { queryAll, execute } from '../db/query';
import { markDirty } from '../db/connection';
import { parseNote } from './parser';
import type { IndexResult, EngramSettings } from '../types';

/**
 * Full vault index using Obsidian Vault API.
 * Compares mtime to skip unchanged files.
 */
export async function runIndex(app: App, settings: EngramSettings, force = false): Promise<IndexResult> {
  const start = Date.now();
  const skipSet = new Set(settings.skipDirectories);

  const mdFiles = app.vault.getMarkdownFiles().filter(f => {
    const topDir = f.path.split('/')[0];
    return !skipSet.has(topDir) && !f.path.startsWith('.');
  });

  const scannedPaths = new Set(mdFiles.map(f => f.path));

  // Get existing indexed files
  const existing = queryAll<{ path: string; modified_at: number }>('SELECT path, modified_at FROM files');
  const existingMap = new Map(existing.map(f => [f.path, f.modified_at]));

  let indexed = 0;
  let skipped = 0;

  for (const file of mdFiles) {
    const mtime = file.stat.mtime;
    const existingMtime = existingMap.get(file.path);

    if (!force && existingMtime && Math.abs(existingMtime - mtime) < 1000) {
      skipped++;
      continue;
    }

    try {
      const raw = await app.vault.cachedRead(file);
      const parsed = parseNote(app, file, raw);
      const directory = file.path.split('/')[0] || '';

      execute(
        `INSERT INTO files (path, title, directory, tags, frontmatter, wiki_links, content, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           directory = excluded.directory,
           tags = excluded.tags,
           frontmatter = excluded.frontmatter,
           wiki_links = excluded.wiki_links,
           content = excluded.content,
           modified_at = excluded.modified_at,
           indexed_at = excluded.indexed_at`,
        [
          file.path,
          parsed.title,
          directory,
          JSON.stringify(parsed.tags),
          JSON.stringify(parsed.frontmatter),
          JSON.stringify(parsed.wikiLinks),
          parsed.content,
          mtime,
          Date.now(),
        ]
      );
      indexed++;
    } catch (err) {
      console.error(`[Engram] Failed to index ${file.path}:`, err);
      skipped++;
    }

    // Yield to main thread every 50 files
    if (indexed % 50 === 0) {
      await sleep(0);
    }
  }

  // Delete files no longer in vault
  let deleted = 0;
  for (const ex of existing) {
    if (!scannedPaths.has(ex.path)) {
      execute('DELETE FROM files WHERE path = ?', [ex.path]);
      deleted++;
    }
  }

  markDirty();
  return { indexed, skipped, deleted, durationMs: Date.now() - start };
}

/**
 * Index a single file (for real-time event handling).
 */
export async function indexFile(app: App, file: TFile): Promise<void> {
  try {
    const raw = await app.vault.cachedRead(file);
    const parsed = parseNote(app, file, raw);
    const directory = file.path.split('/')[0] || '';

    execute(
      `INSERT INTO files (path, title, directory, tags, frontmatter, wiki_links, content, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title,
         directory = excluded.directory,
         tags = excluded.tags,
         frontmatter = excluded.frontmatter,
         wiki_links = excluded.wiki_links,
         content = excluded.content,
         modified_at = excluded.modified_at,
         indexed_at = excluded.indexed_at`,
      [
        file.path,
        parsed.title,
        directory,
        JSON.stringify(parsed.tags),
        JSON.stringify(parsed.frontmatter),
        JSON.stringify(parsed.wikiLinks),
        parsed.content,
        file.stat.mtime,
        Date.now(),
      ]
    );
    markDirty();
  } catch (err) {
    console.error(`[Engram] Failed to index ${file.path}:`, err);
  }
}

/**
 * Remove a file from the index.
 */
export function removeFile(path: string): void {
  execute('DELETE FROM files WHERE path = ?', [path]);
  markDirty();
}

/**
 * Rename a file in the index.
 */
export function renameFile(oldPath: string, newPath: string): void {
  const newTitle = newPath.split('/').pop()?.replace(/\.md$/, '') ?? newPath;
  const newDir = newPath.split('/')[0] || '';
  execute(
    'UPDATE files SET path = ?, title = ?, directory = ? WHERE path = ?',
    [newPath, newTitle, newDir, oldPath]
  );
  markDirty();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
