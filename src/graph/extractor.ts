import { queryAll, execute } from '../db/query';
import { markDirty } from '../db/connection';
import { upsertEntity, getAllEntities, findEntityByName } from './entity-store';
import { addRelationship } from './relationship-store';
import { addFact } from './fact-store';
import type { Entity, ExtractionResult } from '../types';

interface FileRow {
  path: string;
  title: string;
  content: string;
  wiki_links: string | null;
  frontmatter: string | null;
  modified_at: number;
  graph_extracted_at: number | null;
}

interface FrontmatterMapping {
  property: string;
  relationshipType: string;
  targetEntityType: string;
  isArray: boolean;
}

const FRONTMATTER_MAPPINGS: FrontmatterMapping[] = [
  { property: '소속', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'organization', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'team', relationshipType: 'belongs-to', targetEntityType: 'organization', isArray: false },
  { property: 'project', relationshipType: 'related-to', targetEntityType: 'project', isArray: false },
  { property: 'attendees', relationshipType: 'attended', targetEntityType: 'person', isArray: true },
];

const EXCLUDE_NAMES = new Set(['나', 'user', 'i', 'me']);

/**
 * Seed person entities from a people directory in the vault.
 * In Obsidian plugin, we scan files in the specified directory.
 */
export function seedEntitiesFromFiles(
  peopleDir: string,
  files: Array<{ path: string; frontmatter: Record<string, unknown> }>
): number {
  const existingEntities = getAllEntities();
  const existingNames = new Set(existingEntities.map(e => e.name));
  const existingIds = new Set(existingEntities.map(e => e.id));

  let seeded = 0;
  for (const file of files) {
    // e.g., "5-사람/고동현/요약.md" → extract "고동현"
    const rel = file.path.startsWith(peopleDir + '/')
      ? file.path.slice(peopleDir.length + 1)
      : file.path;
    const parts = rel.split('/');
    if (parts.length < 2) continue;

    const name = parts[0];
    const id = name;
    if (existingIds.has(id) || existingNames.has(name)) continue;

    upsertEntity({
      id,
      type: 'person',
      name,
      aliases: [],
      metadata: file.frontmatter,
      sourcePath: file.path,
    });
    seeded++;
  }
  return seeded;
}

/**
 * Main extraction pipeline — same logic as original, adapted for query helpers.
 */
export function runExtraction(opts?: { force?: boolean; limit?: number }): ExtractionResult {
  const start = Date.now();

  const query = opts?.force
    ? 'SELECT path, title, content, wiki_links, frontmatter, modified_at, graph_extracted_at FROM files'
    : 'SELECT path, title, content, wiki_links, frontmatter, modified_at, graph_extracted_at FROM files WHERE graph_extracted_at IS NULL OR graph_extracted_at < modified_at';

  let files = queryAll<FileRow>(query);
  if (opts?.limit) files = files.slice(0, opts.limit);
  if (files.length === 0) {
    return { entitiesDiscovered: 0, relationships: 0, facts: 0, filesProcessed: 0, durationMs: Date.now() - start };
  }

  let entitiesDiscovered = 0;
  let relationships = 0;
  let facts = 0;

  // Phase C-1: Organization entities from person metadata
  const orgResult = extractOrgsFromPersonMetadata();
  entitiesDiscovered += orgResult.entities;
  relationships += orgResult.relationships;

  // Build entity name map
  const entityNames = buildEntityNameMap();

  for (const file of files) {
    const fileEntities = new Map<string, Entity>();

    // Phase B: Resolve wiki-links to entities
    const wikiLinks: string[] = safeJsonParse(file.wiki_links, []);
    for (const link of wikiLinks) {
      const entity = resolveWikiLink(link);
      if (entity && !EXCLUDE_NAMES.has(entity.name.toLowerCase())) {
        fileEntities.set(entity.id, entity);
      }
    }

    // Co-mention fallback
    const contentLower = file.content.toLowerCase();
    for (const [name, entity] of entityNames) {
      if (EXCLUDE_NAMES.has(name)) continue;
      if (fileEntities.has(entity.id)) continue;
      if (contentLower.includes(name)) {
        fileEntities.set(entity.id, entity);
      }
    }

    const unique = [...fileEntities.values()];

    // Co-mentioned relationships
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        try {
          addRelationship({
            sourceId: unique[i].id,
            targetId: unique[j].id,
            type: 'co-mentioned',
            context: file.path,
            sourceFile: file.path,
          });
          relationships++;
        } catch { /* duplicate */ }
      }
    }

    // Mention fact
    if (unique.length > 0) {
      const recordedAt = extractDate(file.path, file.modified_at);
      const fileName = file.path.split('/').pop()?.replace(/\.md$/, '') ?? file.path;
      addFact({
        type: 'mention',
        content: fileName,
        entityIds: unique.map(e => e.id),
        recordedAt,
        sourceFile: file.path,
      });
      facts++;
    }

    // Phase C-2: Frontmatter relationships
    const fmResult = extractFileFrontmatter(file);
    entitiesDiscovered += fmResult.entities;
    relationships += fmResult.relationships;
    facts += fmResult.facts;
  }

  // Mark files as extracted
  const now = Date.now();
  for (const f of files) {
    execute('UPDATE files SET graph_extracted_at = ? WHERE path = ?', [now, f.path]);
  }

  markDirty();
  return { entitiesDiscovered, relationships, facts, filesProcessed: files.length, durationMs: Date.now() - start };
}

function resolveWikiLink(link: string): Entity | null {
  const entity = findEntityByName(link);
  if (entity) return entity;

  const segments = link.split('/');
  if (segments.length > 1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const found = findEntityByName(segments[i]);
      if (found) return found;
    }
  }
  return null;
}

function extractOrgsFromPersonMetadata(): { entities: number; relationships: number } {
  let entities = 0;
  let rels = 0;

  const orgMappings = FRONTMATTER_MAPPINGS.filter(m => m.targetEntityType === 'organization');
  const personEntities = getAllEntities().filter(e => e.type === 'person');

  for (const person of personEntities) {
    for (const mapping of orgMappings) {
      const value = person.metadata[mapping.property];
      if (!value || typeof value !== 'string') continue;
      const orgName = value.trim();
      if (!orgName) continue;

      let orgEntity = findEntityByName(orgName);
      if (!orgEntity) {
        upsertEntity({ id: orgName, type: 'organization', name: orgName, aliases: [] });
        orgEntity = findEntityByName(orgName);
        if (orgEntity) entities++;
      }

      if (orgEntity) {
        try {
          addRelationship({
            sourceId: person.id,
            targetId: orgEntity.id,
            type: mapping.relationshipType,
            sourceFile: person.sourcePath ?? undefined,
          });
          rels++;
        } catch { /* duplicate */ }
      }
    }
  }

  return { entities, relationships: rels };
}

function extractFileFrontmatter(file: FileRow): { entities: number; relationships: number; facts: number } {
  let entities = 0;
  let rels = 0;
  let facts = 0;

  const fm: Record<string, unknown> = safeJsonParse(file.frontmatter, {});
  if (!fm || Object.keys(fm).length === 0) return { entities: 0, relationships: 0, facts: 0 };

  for (const mapping of FRONTMATTER_MAPPINGS) {
    const raw = fm[mapping.property];
    if (raw == null) continue;

    const values: string[] = mapping.isArray
      ? (Array.isArray(raw) ? raw.map(String) : [String(raw)])
      : [String(raw)];

    const resolvedEntities: Entity[] = [];

    for (const val of values) {
      const name = val.trim();
      if (!name || EXCLUDE_NAMES.has(name.toLowerCase())) continue;

      let targetEntity = findEntityByName(name);
      if (!targetEntity && mapping.targetEntityType !== 'person') {
        upsertEntity({ id: name, type: mapping.targetEntityType, name, aliases: [] });
        targetEntity = findEntityByName(name);
        if (targetEntity) entities++;
      }

      if (targetEntity) resolvedEntities.push(targetEntity);
    }

    if (resolvedEntities.length === 0) continue;

    if (mapping.relationshipType === 'attended') {
      const recordedAt = extractDate(file.path, file.modified_at);
      const fileName = file.path.split('/').pop()?.replace(/\.md$/, '') ?? file.path;
      addFact({
        type: 'attended',
        content: fileName,
        entityIds: resolvedEntities.map(e => e.id),
        recordedAt,
        sourceFile: file.path,
      });
      facts++;
    } else {
      const ownerEntity = findFileOwnerEntity(file.path);
      if (ownerEntity) {
        for (const target of resolvedEntities) {
          if (ownerEntity.id === target.id) continue;
          try {
            addRelationship({
              sourceId: ownerEntity.id,
              targetId: target.id,
              type: mapping.relationshipType,
              sourceFile: file.path,
            });
            rels++;
          } catch { /* duplicate */ }
        }
      }
    }
  }

  return { entities, relationships: rels, facts };
}

function buildEntityNameMap(): Map<string, Entity> {
  const entities = getAllEntities();
  const map = new Map<string, Entity>();
  for (const e of entities) {
    map.set(e.name.toLowerCase(), e);
    for (const alias of e.aliases) {
      map.set(alias.toLowerCase(), e);
    }
  }
  return map;
}

function findFileOwnerEntity(filePath: string): Entity | null {
  // Look for person directories like "5-사람/Name/..."
  const parts = filePath.split('/');
  if (parts.length >= 3) {
    const entity = findEntityByName(parts[1]);
    if (entity && entity.type === 'person') return entity;
  }
  return null;
}

function extractDate(filePath: string, modifiedAt: number): string {
  const isoMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  const dotMatch = filePath.match(/(\d{2})\.(\d{2})\.(\d{2})/);
  if (isoMatch) return isoMatch[1];
  if (dotMatch) {
    const yy = parseInt(dotMatch[1], 10);
    const century = yy >= 90 ? '19' : '20';
    return `${century}${dotMatch[1]}-${dotMatch[2]}-${dotMatch[3]}`;
  }
  return new Date(modifiedAt).toISOString().slice(0, 10);
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
