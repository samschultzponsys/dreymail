// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: tablet/foldable two-pane layout; interface size.
// Modified by samschultzponsys, 2026-11-15: Outlook accounts; This device settings.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: message after connecting single sign-on.
// Modified by samschultzponsys, 2026-11-16: links to other sites never replace the app.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { guardLinks } from './linkGuard';
import { PENDING_MAILTO_KEY, takeMailtoParam } from './mailto';
import { applyUiScale } from './uiScale';
import './styles.css';

// Apply the system theme before the first render to avoid a flash.
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
// Interface size for this device (Settings → General).
applyUiScale();
// Links to other sites open in a new window, never in place of the app.
guardLinks();

// Opened for a mailto: link (?mailto=…): keep the link for this tab, so it survives a sign-in
// round trip, and drop it from the URL so a reload doesn't open the composer again.
const opened = takeMailtoParam(window.location.search);
if (opened) {
  if (opened.mailto) sessionStorage.setItem(PENDING_MAILTO_KEY, opened.mailto);
  window.history.replaceState(window.history.state, '', window.location.pathname + opened.search + window.location.hash);
}

// Back from "Sign in with Microsoft" (?outlook=added|error): remember the outcome for the app to
// announce, and clean the URL.
{
  const q = new URLSearchParams(window.location.search);
  const outcome = q.get('outlook');
  if (outcome) {
    sessionStorage.setItem(
      'dreymail.outlook',
      JSON.stringify({ ok: outcome === 'added', message: q.get('message') ?? '', account: q.get('account') ?? '', provider: q.get('provider') ?? 'microsoft' }),
    );
    for (const k of ['outlook', 'message', 'account', 'provider']) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }
}

// Back from connecting single sign-on (?sso=connected|error): the same, for the app to announce.
{
  const q = new URLSearchParams(window.location.search);
  const sso = q.get('sso');
  if (sso) {
    sessionStorage.setItem('dreymail.sso', JSON.stringify({ ok: sso === 'connected', message: q.get('message') ?? '' }));
    for (const k of ['sso', 'message']) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
