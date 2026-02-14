import { getDb } from './connection';

/**
 * Execute SQL that returns rows (SELECT).
 * sql.js returns an array of { columns, values } result sets.
 */
export function queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params as any);

  const rows: T[] = [];
  while (stmt.step()) {
    const colNames = stmt.getColumnNames();
    const vals = stmt.get();
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < colNames.length; i++) {
      obj[colNames[i]] = vals[i];
    }
    rows.push(obj as T);
  }
  stmt.free();
  return rows;
}

/**
 * Execute SQL that returns a single row.
 */
export function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const results = queryAll<T>(sql, params);
  return results.length > 0 ? results[0] : null;
}

/**
 * Execute SQL that does not return rows (INSERT, UPDATE, DELETE, CREATE, etc.).
 */
export function execute(sql: string, params: unknown[] = []): void {
  const db = getDb();
  if (params.length === 0) {
    db.run(sql);
  } else {
    db.run(sql, params as any);
  }
}

/**
 * Execute multiple SQL statements (like schema migrations).
 */
export function execMulti(sql: string): void {
  const db = getDb();
  db.exec(sql);
}

/**
 * Get the last inserted rowid.
 */
export function lastInsertRowid(): number {
  const row = queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
  return row?.id ?? 0;
}
