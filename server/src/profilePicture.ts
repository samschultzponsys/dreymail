// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Profile pictures: a small square image the browser has already cropped and scaled, stored in the
// database. Without one, the user's Gravatar (fetched by the server, see net/avatars.ts) if they allow it.

import type { Store, User } from './db.js';

export const MAX_PICTURE_BYTES = 300 * 1024;

const TYPES: { type: string; magic: (b: Buffer) => boolean }[] = [
  { type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export class PictureError extends Error {}

/** A data: URL from the picture editor → checked image bytes. The content must match its type. */
export function parsePicture(dataUrl: string): { type: string; body: Buffer } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new PictureError('Use a PNG, JPEG or WebP picture');
  const body = Buffer.from(m[2]!, 'base64');
  if (body.length === 0 || body.length > MAX_PICTURE_BYTES) throw new PictureError('That picture is too large');
  const kind = TYPES.find((t) => t.magic(body));
  if (!kind || kind.type !== m[1]) throw new PictureError("That file isn't a picture");
  return { type: kind.type, body };
}

/** The address a Gravatar is looked up for: the sign-in email, else the first mailbox's. */
export function gravatarEmail(store: Store, user: User): string | null {
  if (user.email.includes('@')) return user.email;
  return store.listAccounts(user.id)[0]?.email ?? null;
}

/** The picture URL the web app shows, or null for initials. Versioned so browsers can cache it. */
export function pictureUrl(store: Store, user: User): string | null {
  if (user.avatarVersion) return `/api/users/${user.id}/picture?v=${user.avatarVersion}`;
  if (user.gravatar && gravatarEmail(store, user)) return `/api/users/${user.id}/picture?v=g`;
  return null;
}
