import type { App } from 'obsidian';
import type { EngramSettings, VaultStats, SearchResult, SemanticResult, IndexResult, EmbedResult, ExtractionResult } from './types';
import { queryAll, queryOne } from './db/query';
import { runIndex, indexFile, removeFile, renameFile } from './indexer/indexer';
import { embed, isOllamaRunning } from './embeddings/ollama-client';
import { searchVectors, loadVectors, findSimilarByFile, getVectorCount } from './embeddings/vector-store';
import { runEmbedIndex } from './embeddings/embed-indexer';
import { getAllEntities, searchEntities as searchEntitiesStore } from './graph/entity-store';
import { getRelationships, getAllRelationships } from './graph/relationship-store';
import { queryFacts } from './graph/fact-store';
import { runExtraction } from './graph/extractor';
import type { TFile } from 'obsidian';

/**
 * EngramEngine — single facade for all subsystems.
 */
export class EngramEngine {
  constructor(
    private app: App,
    private settings: EngramSettings,
  ) {}

  // ───── Indexing ─────

  async fullIndex(force = false): Promise<IndexResult> {
    return runIndex(this.app, this.settings, force);
  }

  async indexSingleFile(file: TFile): Promise<void> {
    return indexFile(this.app, file);
  }

  removeFromIndex(path: string): void {
    removeFile(path);
  }

  renameInIndex(oldPath: string, newPath: string): void {
    renameFile(oldPath, newPath);
  }

  // ───── FTS Search ─────

  search(query: string, opts?: { directory?: string; tag?: string; limit?: number }): SearchResult[] {
    const limit = opts?.limit ?? 20;
    let sql = `
      SELECT f.path, f.title, f.directory, f.tags, f.modified_at as modifiedAt,
             snippet(files_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
      FROM files_fts fts
      JOIN files f ON f.id = fts.rowid
      WHERE files_fts MATCH ?
    `;
    const params: unknown[] = [query];

    if (opts?.directory) {
      sql += ' AND f.directory = ?';
      params.push(opts.directory);
    }
    if (opts?.tag) {
      sql += ' AND f.tags LIKE ?';
      params.push(`%${opts.tag}%`);
    }
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    return queryAll<SearchResult>(sql, params);
  }

  // ───── Semantic Search ─────

  async semanticSearch(query: string, topK = 10): Promise<SemanticResult[]> {
    const queryVec = await embed(query);
    const vectorResults = searchVectors(queryVec, topK);

    return vectorResults.map(v => {
      const file = queryOne<{ path: string; title: string }>('SELECT path, title FROM files WHERE id = ?', [v.fileId]);
      const chunk = queryOne<{ chunk_text: string }>('SELECT chunk_text FROM embeddings WHERE id = ?', [v.id]);
      return {
        path: file?.path ?? '',
        title: file?.title ?? '',
        heading: v.heading,
        score: Math.round(v.score * 1000) / 1000,
        chunkText: chunk?.chunk_text ?? '',
      };
    });
  }

  async isOllamaAvailable(): Promise<boolean> {
    return isOllamaRunning();
  }

  loadVectorCache(): number {
    return loadVectors();
  }

  getVectorCount(): number {
    return getVectorCount();
  }

  async runEmbedding(force = false, onProgress?: (pct: number, msg: string) => void): Promise<EmbedResult> {
    return runEmbedIndex(force, onProgress);
  }

  findSimilar(filePath: string, topK = 10) {
    return findSimilarByFile(filePath, topK);
  }

  // ───── Graph ─────

  runGraphExtraction(opts?: { force?: boolean; limit?: number }): ExtractionResult {
    return runExtraction(opts);
  }

  getGraphData(typeFilter?: string, relTypeFilter?: string) {
    const allEntities = getAllEntities();
    const entities = typeFilter ? allEntities.filter(e => e.type === typeFilter) : allEntities;

    const allRels = getAllRelationships(relTypeFilter);
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const edges = allRels.filter(r => entityMap.has(r.sourceId) && entityMap.has(r.targetId));

    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(e.sourceId);
      connectedIds.add(e.targetId);
    }

    const nodeList = typeFilter ? entities : entities.filter(e => connectedIds.has(e.id));

    const TYPE_COLORS: Record<string, string> = {
      person: '#3b82f6',
      organization: '#22c55e',
      project: '#f97316',
      team: '#a855f7',
      topic: '#eab308',
      event: '#ec4899',
    };

    const nodes = nodeList.map(e => ({
      id: e.id,
      label: e.name,
      group: e.type,
      color: TYPE_COLORS[e.type] ?? '#6b7280',
      title: `${e.name} (${e.type})`,
    }));

    const edgesOut = edges.map(r => ({
      from: r.sourceId,
      to: r.targetId,
      label: r.type,
      id: r.id,
    }));

    return { nodes, edges: edgesOut };
  }

  searchEntities(query: string, type?: string) {
    return searchEntitiesStore(query, type);
  }

  getEntityRelationships(entityId: string, type?: string) {
    return getRelationships(entityId, type);
  }

  getEntityFacts(entityId: string, type?: string) {
    return queryFacts({ entityId, type });
  }

  // ───── Stats ─────

  getStats(): VaultStats {
    const files = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM files')?.c ?? 0;
    const embeddings = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM embeddings')?.c ?? 0;
    const entities = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM entities')?.c ?? 0;
    const relationships = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM relationships')?.c ?? 0;
    const facts = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM facts')?.c ?? 0;

    const directories = queryAll<{ name: string; count: number }>(
      'SELECT directory as name, COUNT(*) as count FROM files GROUP BY directory ORDER BY count DESC'
    );
    const entityTypes = queryAll<{ type: string; count: number }>(
      'SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC'
    );

    return { files, embeddings, entities, relationships, facts, directories, entityTypes };
  }

  // ───── DB Explorer ─────

  getTables() {
    const tables = queryAll<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    return tables.map(t => {
      const columns = queryAll<{ cid: number; name: string; type: string; notnull: number; pk: number }>(
        `PRAGMA table_info("${t.name}")`
      );
      const rowCount = queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${t.name}"`)?.c ?? 0;
      return {
        name: t.name,
        sql: t.sql,
        columns: columns.map(c => ({
          name: c.name,
          type: c.type,
          notnull: !!c.notnull,
          pk: !!c.pk,
        })),
        rowCount,
      };
    });
  }

  getTableRows(tableName: string, opts?: { limit?: number; offset?: number; sort?: string; order?: string }) {
    // Validate table exists
    const validTables = queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    );
    const tableNames = new Set(validTables.map(t => t.name));
    if (!tableNames.has(tableName)) {
      return { columns: [] as string[], rows: [] as Record<string, unknown>[], total: 0, limit: 0, offset: 0 };
    }

    const columns = queryAll<{ name: string }>(`PRAGMA table_info("${tableName}")`).map(c => c.name);
    const limit = Math.min(opts?.limit ?? 50, 500);
    const offset = opts?.offset ?? 0;
    const sort = opts?.sort ?? '';
    const order = opts?.order === 'desc' ? 'DESC' : 'ASC';

    const total = queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM "${tableName}"`)?.c ?? 0;

    let sql = `SELECT * FROM "${tableName}"`;
    if (sort && columns.includes(sort)) {
      sql += ` ORDER BY "${sort}" ${order}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const rows = queryAll<Record<string, unknown>>(sql);

    // Truncate large values
    const truncatedRows = rows.map(row => {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (typeof val === 'string' && val.length > 500) {
          out[key] = val.slice(0, 500) + '...';
        } else if (val instanceof Uint8Array) {
          out[key] = `[BLOB ${val.length} bytes]`;
        } else {
          out[key] = val;
        }
      }
      return out;
    });

    return { columns, rows: truncatedRows, total, limit, offset };
  }
}
