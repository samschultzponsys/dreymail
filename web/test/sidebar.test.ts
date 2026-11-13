// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: renders inside a QueryClientProvider (the sidebar shows the version).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../../shared/types';
import { Sidebar } from '../src/components/Sidebar';

beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };
});

const account = { id: 'a1', name: 'Work', color: '#3b82f6' } as AccountView;
const noop = () => {};

function render(folders: Parameters<typeof Sidebar>[0]['folders']) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Sidebar, {
      accounts: [account],
      showUnified: true,
      userFullName: 'me',
      folders,
      sel: { accountId: 'a1', folder: 'INBOX' },
      onSelect: noop,
      onCompose: noop,
      onAccounts: noop,
      onSettings: noop,
      onLogout: noop,
      userLabel: 'me',
      onCloseNav: noop,
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
