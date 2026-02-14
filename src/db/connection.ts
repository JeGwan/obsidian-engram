// sql.js-fts5 has the same API as sql.js but with FTS5 enabled
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Callbacks for persistence — set by main.ts
let onSave: ((data: Uint8Array) => Promise<void>) | null = null;

export function setDb(database: SqlJsDatabase): void {
  db = database;
  dirty = false;
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('Engram DB not initialized');
  return db;
}

export function isDbReady(): boolean {
  return db !== null;
}

export function setSaveCallback(fn: (data: Uint8Array) => Promise<void>): void {
  onSave = fn;
}

export function markDirty(): void {
  dirty = true;
  debounceSave();
}

function debounceSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDb();
  }, 30000); // 30 second debounce
}

export async function saveDb(): Promise<void> {
  if (!db || !dirty || !onSave) return;
  try {
    const data = db.export();
    await onSave(new Uint8Array(data));
    dirty = false;
  } catch (e) {
    console.error('[Engram] Failed to save DB:', e);
  }
}

export async function closeDb(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (db && dirty && onSave) {
    const data = db.export();
    await onSave(new Uint8Array(data));
  }
  if (db) {
    db.close();
    db = null;
  }
  dirty = false;
}
