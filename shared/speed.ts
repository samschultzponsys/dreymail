// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/** How fast DreyMail is for the people using it (DreyMail 14.5): Settings → Server → Speed. */

export const SPEED_METRICS = {
  startup: 'Starting DreyMail, until the mail list shows',
  startupNew: 'Starting on a new device (nothing remembered yet)',
  open: 'Opening a message',
  list: 'Listing a folder',
  search: 'Searching',
  attachment: 'Opening a picture or attachment',
  action: 'Archive, delete, mark read and other actions',
  send: 'Sending',
} as const;

export type SpeedMetric = keyof typeof SPEED_METRICS;

export interface SpeedRow {
  metric: SpeedMetric;
  label: string;
  /** Measurements since the server started. */
  count: number;
  /** Of the most recent measurements (up to 500), in ms: the typical one, 1 in 20 slower than `p95`, and the slowest. */
  median: number | null;
  p95: number | null;
  max: number | null;
}

export interface SpeedView {
  since: string;
  rows: SpeedRow[];
}
