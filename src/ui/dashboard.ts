import { BaseRenderer } from './base-renderer';
import { el, createStatCard, animateCounters, createDistributionBar } from './components';

export class DashboardRenderer extends BaseRenderer {
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    const stats = this.engine.getStats();

    // Stats grid
    const grid = el('div', { class: 'engram-stats-grid' });
    grid.appendChild(createStatCard('Files', stats.files, '📄'));
    grid.appendChild(createStatCard('Embeddings', stats.embeddings, '🧠'));
    grid.appendChild(createStatCard('Entities', stats.entities, '🔗'));
    grid.appendChild(createStatCard('Relationships', stats.relationships, '↔'));
    grid.appendChild(createStatCard('Facts', stats.facts, '💡'));
    container.appendChild(grid);

    // Animate counters
    requestAnimationFrame(() => animateCounters(grid));

    // Directory distribution
    if (stats.directories.length > 0) {
      container.appendChild(el('h3', { class: 'engram-section-title', text: 'File Distribution' }));
      container.appendChild(createDistributionBar(stats.directories, stats.files));
    }

    // Entity type distribution
    if (stats.entityTypes.length > 0) {
      container.appendChild(el('h3', { class: 'engram-section-title', text: 'Entity Types' }));
      container.appendChild(createDistributionBar(
        stats.entityTypes.map(t => ({ name: t.type, count: t.count })),
        stats.entities
      ));
    }
  }
}
