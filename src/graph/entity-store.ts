import { queryAll, queryOne, execute } from '../db/query';
import { markDirty } from '../db/connection';
import type { Entity } from '../types';

export function getEntity(id: string): Entity | null {
  const row = queryOne<any>('SELECT * FROM entities WHERE id = ?', [id]);
  if (!row) return null;
  return deserializeEntity(row);
}

export function getAllEntities(): Entity[] {
  const rows = queryAll<any>('SELECT * FROM entities');
  return rows.map(deserializeEntity);
}

export function searchEntities(query: string, type?: string): Entity[] {
  const likeQuery = `%${query}%`;
  let sql = 'SELECT * FROM entities WHERE (name LIKE ? OR aliases LIKE ? OR id LIKE ?)';
  const params: unknown[] = [likeQuery, likeQuery, likeQuery];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' LIMIT 20';
  const rows = queryAll<any>(sql, params);
  return rows.map(deserializeEntity);
}

export function upsertEntity(entity: {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  sourcePath?: string;
}): void {
  execute(
    `INSERT INTO entities (id, type, name, aliases, metadata, source_path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       name = excluded.name,
       aliases = excluded.aliases,
       metadata = excluded.metadata,
       source_path = excluded.source_path`,
    [
      entity.id,
      entity.type,
      entity.name,
      JSON.stringify(entity.aliases ?? []),
      JSON.stringify(entity.metadata ?? {}),
      entity.sourcePath ?? null,
    ]
  );
  markDirty();
}

export function findEntityByName(name: string): Entity | null {
  // Exact name match (case-insensitive)
  const row = queryOne<any>('SELECT * FROM entities WHERE name = ? COLLATE NOCASE', [name]);
  if (row) return deserializeEntity(row);

  // Alias match
  const rows = queryAll<any>('SELECT * FROM entities WHERE aliases LIKE ?', [`%${JSON.stringify(name).slice(1, -1)}%`]);
  for (const r of rows) {
    const entity = deserializeEntity(r);
    if (entity.aliases.some(a => a.toLowerCase() === name.toLowerCase())) return entity;
  }
  return null;
}

function deserializeEntity(row: any): Entity {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    aliases: safeJsonParse(row.aliases, []),
    metadata: safeJsonParse(row.metadata, {}),
    sourcePath: row.source_path,
  };
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
