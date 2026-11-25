// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// How fast DreyMail is for the people using it (DreyMail 14.5): how long requests took, kept in
// memory only (the most recent 500 of each kind; nothing about whose or which mail), for
// Settings → Server → Speed. Starting the app is reported by the app itself.

import { decodeFilters, filterCount } from '../../shared/search.js';
import { SPEED_METRICS, type SpeedMetric, type SpeedView } from '../../shared/speed.js';

const KEEP = 500;

export class SpeedStats {
  private readonly recent = new Map<SpeedMetric, number[]>();
  private readonly counts = new Map<SpeedMetric, number>();
  private readonly since = new Date();

  record(metric: SpeedMetric, ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.recent.get(metric) ?? [];
    list.push(ms);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    this.recent.set(metric, list);
    this.counts.set(metric, (this.counts.get(metric) ?? 0) + 1);
  }

  view(): SpeedView {
    const at = (sorted: number[], q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : null);
    return {
      since: this.since.toISOString(),
      rows: (Object.keys(SPEED_METRICS) as SpeedMetric[]).map((metric) => {
        const sorted = [...(this.recent.get(metric) ?? [])].sort((a, b) => a - b);
        return { metric, label: SPEED_METRICS[metric], count: this.counts.get(metric) ?? 0, median: at(sorted, 0.5), p95: at(sorted, 0.95), max: sorted.length ? Math.round(sorted.at(-1)!) : null };
      }),
    };
  }
}

/** Which measurement a finished API request is, if any (successful ones only). */
export function speedMetricOf(method: string, route: string | undefined, query: Record<string, unknown>, status: number): SpeedMetric | null {
  if (status >= 400 || !route) return null;
  if (method === 'GET' && route === '/api/message') return 'open';
  if (method === 'GET' && route === '/api/attachment') return 'attachment';
  if (method === 'GET' && route === '/api/messages') {
    // Later pages (scrolling) and refreshes are lists too; a word search or filters are searches.
    if (query.quick === '1') return null;
    const filters = decodeFilters(typeof query.filter === 'string' ? query.filter : '');
    return query.q || filterCount(filters) > 0 || filters.where === 'all' ? 'search' : 'list';
  }
  if (method === 'POST' && route === '/api/messages/actions') return 'action';
  if (method === 'POST' && route === '/api/send') return 'send';
  return null;
}
