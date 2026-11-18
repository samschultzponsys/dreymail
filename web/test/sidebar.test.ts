// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: renders inside a QueryClientProvider (the sidebar shows the version).
// Modified by samschultzponsys, 2026-11-15: saved searches props.
// Modified by samschultzponsys, 2026-11-15: roles and permissions, profile pictures, grouped settings, empty mailbox screen.
// Modified by samschultzponsys, 2026-11-18: no ⌄ line when every folder is pinned; the open mailbox at the top.
// Modified by samschultzponsys, 2026-11-18: the unread bubble for folded or unpinned folders flashes on new mail.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../../shared/types';
import { Sidebar, UnreadBubble } from '../src/components/Sidebar';

beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };
});

const account = { id: 'a1', name: 'Work', color: '#3b82f6' } as AccountView;
const noop = () => {};

function render(folders: Parameters<typeof Sidebar>[0]['folders'], accounts: AccountView[] = [account], sel: { accountId: string | null; folder: string } = { accountId: 'a1', folder: 'INBOX' }) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Sidebar, {
      accounts,
      showUnified: true,
      userFullName: 'me',
      folders,
      sel,
      onSelect: noop,
      onCompose: noop,
      onAccounts: noop,
      onSettings: noop,
      onLogout: noop,
      userLabel: 'me',
      onCloseNav: noop,
      searches: [],
      userAvatar: null,
      activeSearch: null,
      onSearch: noop,
      onDeleteSearch: noop,
      }),
    ),
  );
}

describe('Sidebar', () => {
  it('shows a spinner instead of "Loading…" text while an account\'s folders load', () => {
    const html = render(undefined);
    expect(html).toContain('class="nav-loading"');
    expect(html).toContain('class="spinner"');
    expect(html).not.toContain('Loading…');
  });

  it('hides the spinner once the folders have arrived', () => {
    const html = render([{ accountId: 'a1', folders: [] }] as never);
    expect(html).not.toContain('nav-loading');
  });
});

describe('unread in folders out of sight (11.1)', () => {
  const bubble = (count: number) => renderToStaticMarkup(createElement(UnreadBubble, { count, flashKey: 'test', title: 'hidden' }));
  it('stands out, and flashes only when new mail arrives', () => {
    expect(bubble(3)).toContain('hidden-unread');
    expect(bubble(3)).not.toContain('flash');
    expect(bubble(2)).not.toContain('flash');
    expect(bubble(4)).toContain('hidden-unread flash');
    // Keeps flashing for a while, also when drawn again.
    expect(bubble(4)).toContain('flash');
  });
});

describe('the ⌄ line under pinned folders (11.2)', () => {
  const fold = (path: string) => ({ path, name: path, delimiter: '/', parentPath: '', specialUse: null, selectable: true, unread: 0, total: 0 });
  const folders = [{ accountId: 'a1', folders: [fold('Inbox'), fold('Work')] }] as never;
  it('shows while some folders are not pinned, and goes away once all are', () => {
    expect(render(folders, [{ ...account, pinnedFolders: ['Inbox'] } as AccountView])).toContain('nav-more');
    expect(render(folders, [{ ...account, pinnedFolders: ['Work', 'Inbox'] } as AccountView])).not.toContain('nav-more');
  });
});

describe('the top of the bar (11.3)', () => {
  const folders = [{ accountId: 'a1', folders: [{ path: 'INBOX', name: 'INBOX', delimiter: '/', parentPath: '', specialUse: 'inbox', selectable: true, unread: 0, total: 0 }] }] as never;
  it("shows the open mailbox's name and folder, and DreyMail's own mark otherwise", () => {
    const html = render(folders, [{ ...account, icon: 'briefcase' } as AccountView]);
    expect(html).toContain('brand-mailbox-name">Work<');
    expect(html).toContain('brand-mailbox-folder">Inbox<');
    expect(html).not.toContain('brand-mark');
    const all = render(folders, [account], { accountId: null, folder: 'INBOX' });
    expect(all).toContain('brand-mark');
    expect(all).toContain('All inboxes');
  });
});
