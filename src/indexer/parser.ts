import type { App, TFile, CachedMetadata } from 'obsidian';
import type { ParsedNote } from '../types';

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;

/**
 * Parse a note using Obsidian's MetadataCache when available,
 * falling back to regex extraction.
 */
export function parseNote(app: App, file: TFile, rawContent: string): ParsedNote {
  const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);
  const title = file.basename;

  // Frontmatter from cache
  const frontmatter: Record<string, unknown> = cache?.frontmatter
    ? { ...cache.frontmatter }
    : {};
  // Remove Obsidian internal 'position' key
  delete (frontmatter as any).position;

  // Tags: combine frontmatter tags + inline tags from cache
  const tagSet = new Set<string>();
  if (cache?.tags) {
    for (const t of cache.tags) {
      tagSet.add(t.tag.replace(/^#/, ''));
    }
  }
  if (cache?.frontmatter?.tags) {
    const fmTags = cache.frontmatter.tags;
    if (Array.isArray(fmTags)) {
      fmTags.forEach((t: string) => tagSet.add(String(t)));
    } else if (typeof fmTags === 'string') {
      fmTags.split(',').forEach((t: string) => tagSet.add(t.trim()));
    }
  }
  const tags = [...tagSet];

  // Wiki links from cache
  const wikiLinkSet = new Set<string>();
  if (cache?.links) {
    for (const link of cache.links) {
      wikiLinkSet.add(link.link.split('#')[0].split('|')[0].trim());
    }
  }
  // Fallback: regex extraction
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKI_LINK_RE.source, 'g');
  while ((match = re.exec(rawContent)) !== null) {
    wikiLinkSet.add(match[1].trim());
  }

  // Strip frontmatter from content for FTS
  let content = rawContent;
  if (rawContent.startsWith('---')) {
    const endIdx = rawContent.indexOf('---', 3);
    if (endIdx !== -1) {
      content = rawContent.slice(endIdx + 3).trim();
    }
  }

  return {
    title,
    content,
    tags,
    frontmatter,
    wikiLinks: [...wikiLinkSet],
  };
}
