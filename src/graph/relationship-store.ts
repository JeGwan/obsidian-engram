import { queryAll, queryOne, execute, lastInsertRowid } from '../db/query';
import { markDirty } from '../db/connection';
import type { Relationship } from '../types';

export function getRelationships(entityId: string, type?: string): Relationship[] {
  let sql = 'SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?)';
  const params: unknown[] = [entityId, entityId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY id DESC';
  const rows = queryAll<any>(sql, params);
  return rows.map(deserializeRelationship);
}

export function getAllRelationships(relType?: string): Relationship[] {
  let sql = 'SELECT * FROM relationships';
  const params: unknown[] = [];
  if (relType) {
    sql += ' WHERE type = ?';
    params.push(relType);
  }
  const rows = queryAll<any>(sql, params);
  return rows.map(deserializeRelationship);
}

export function addRelationship(rel: {
  sourceId: string;
  targetId: string;
  type: string;
  context?: string;
  validFrom?: string;
  validUntil?: string;
  sourceFile?: string;
}): number {
  // Validate entity IDs exist
  const sourceExists = queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.sourceId]);
  const targetExists = queryOne('SELECT 1 FROM entities WHERE id = ?', [rel.targetId]);
  if (!sourceExists || !targetExists) {
    throw new Error(`Entity not found: ${!sourceExists ? rel.sourceId : rel.targetId}`);
  }

  // Check for duplicate
  const existing = queryOne<{ id: number }>(
    'SELECT id FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?',
    [rel.sourceId, rel.targetId, rel.type]
  );
  if (existing) return existing.id;

  execute(
    `INSERT INTO relationships (source_id, target_id, type, context, valid_from, valid_until, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      rel.sourceId,
      rel.targetId,
      rel.type,
      rel.context ?? null,
      rel.validFrom ?? null,
      rel.validUntil ?? null,
      rel.sourceFile ?? null,
    ]
  );
  markDirty();
  return lastInsertRowid();
}

function deserializeRelationship(row: any): Relationship {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    context: row.context,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    sourceFile: row.source_file,
  };
}
