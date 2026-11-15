// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Server settings of common mail providers, so adding an account needs only the address and
// password. Everything stays editable ("Custom" for anything else).

import type { TlsMode } from './types.js';

export interface MailProvider {
  id: string;
  name: string;
  imap: { host: string; port: number; tls: TlsMode };
  smtp: { host: string; port: number; tls: TlsMode };
  /** DreyMail saves a copy in Sent (false where the provider files sent mail itself). */
  appendSent: boolean;
  /** Addresses at these domains pick this provider by themselves. */
  domains: string[];
  /** What else is needed (an app password, a bridge…). */
  note?: string;
}

const tls = (host: string, port = 993) => ({ host, port, tls: 'tls' as const });
const smtps = (host: string) => ({ host, port: 465, tls: 'tls' as const });
const submission = (host: string) => ({ host, port: 587, tls: 'starttls' as const });
const APP_PASSWORD = 'Needs an app password from the provider (your normal password is refused).';

export const MAIL_PROVIDERS: MailProvider[] = [
  { id: 'gmail', name: 'Gmail (app password)', imap: tls('imap.gmail.com'), smtp: smtps('smtp.gmail.com'), appendSent: false, domains: ['gmail.com', 'googlemail.com'], note: `${APP_PASSWORD} Needs 2-Step Verification. Or use Sign in with Google instead, for your Google calendars too.` },
  { id: 'icloud', name: 'iCloud Mail', imap: tls('imap.mail.me.com'), smtp: submission('smtp.mail.me.com'), appendSent: true, domains: ['icloud.com', 'me.com', 'mac.com'], note: 'Needs an app-specific password (appleid.apple.com → Sign-In and Security).' },
  { id: 'yahoo', name: 'Yahoo Mail', imap: tls('imap.mail.yahoo.com'), smtp: smtps('smtp.mail.yahoo.com'), appendSent: true, domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.de', 'yahoo.fr'], note: APP_PASSWORD },
  { id: 'aol', name: 'AOL Mail', imap: tls('imap.aol.com'), smtp: smtps('smtp.aol.com'), appendSent: true, domains: ['aol.com'], note: APP_PASSWORD },
  { id: 'fastmail', name: 'Fastmail', imap: tls('imap.fastmail.com'), smtp: smtps('smtp.fastmail.com'), appendSent: true, domains: ['fastmail.com', 'fastmail.fm'], note: APP_PASSWORD },
  { id: 'purelymail', name: 'Purelymail', imap: tls('imap.purelymail.com'), smtp: smtps('smtp.purelymail.com'), appendSent: true, domains: ['purelymail.com'] },
  { id: 'proton', name: 'Proton Mail (Bridge)', imap: { host: '127.0.0.1', port: 1143, tls: 'starttls' }, smtp: { host: '127.0.0.1', port: 1025, tls: 'starttls' }, appendSent: false, domains: ['proton.me', 'protonmail.com', 'pm.me'], note: 'Needs Proton Mail Bridge running where DreyMail can reach it: set its address here, and use the password Bridge shows (not your Proton password).' },
  { id: 'zoho', name: 'Zoho Mail', imap: tls('imap.zoho.com'), smtp: smtps('smtp.zoho.com'), appendSent: true, domains: ['zoho.com', 'zohomail.com'], note: 'Turn on IMAP access in Zoho Mail settings first. With 2-factor sign-in, use an app-specific password.' },
  { id: 'zoho-eu', name: 'Zoho Mail (EU)', imap: tls('imap.zoho.eu'), smtp: smtps('smtp.zoho.eu'), appendSent: true, domains: ['zohomail.eu'], note: 'Turn on IMAP access in Zoho Mail settings first.' },
  { id: 'mailbox', name: 'mailbox.org', imap: tls('imap.mailbox.org'), smtp: smtps('smtp.mailbox.org'), appendSent: true, domains: ['mailbox.org'] },
  { id: 'posteo', name: 'Posteo', imap: tls('posteo.de'), smtp: smtps('posteo.de'), appendSent: true, domains: ['posteo.de', 'posteo.net'] },
  { id: 'migadu', name: 'Migadu', imap: tls('imap.migadu.com'), smtp: smtps('smtp.migadu.com'), appendSent: true, domains: [] },
  { id: 'runbox', name: 'Runbox', imap: tls('mail.runbox.com'), smtp: smtps('mail.runbox.com'), appendSent: true, domains: ['runbox.com'] },
  { id: 'disroot', name: 'Disroot', imap: tls('disroot.org'), smtp: smtps('disroot.org'), appendSent: true, domains: ['disroot.org'] },
  { id: 'gmx-com', name: 'GMX (gmx.com)', imap: tls('imap.gmx.com'), smtp: submission('mail.gmx.com'), appendSent: true, domains: ['gmx.com', 'gmx.us'], note: 'Turn on IMAP/POP access in GMX settings first.' },
  { id: 'gmx-net', name: 'GMX (gmx.net, .de, .at, .ch)', imap: tls('imap.gmx.net'), smtp: submission('mail.gmx.net'), appendSent: true, domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'], note: 'Turn on IMAP/POP access in GMX settings first.' },
  { id: 'webde', name: 'WEB.DE', imap: tls('imap.web.de'), smtp: submission('smtp.web.de'), appendSent: true, domains: ['web.de'], note: 'Turn on IMAP/POP access in WEB.DE settings first.' },
  { id: 'mailcom', name: 'mail.com', imap: tls('imap.mail.com'), smtp: submission('smtp.mail.com'), appendSent: true, domains: ['mail.com', 'email.com', 'usa.com'] },
  { id: 'yandex', name: 'Yandex Mail', imap: tls('imap.yandex.com'), smtp: smtps('smtp.yandex.com'), appendSent: true, domains: ['yandex.com', 'yandex.ru', 'ya.ru'], note: APP_PASSWORD },
  { id: 'comcast', name: 'Xfinity / Comcast', imap: tls('imap.comcast.net'), smtp: submission('smtp.comcast.net'), appendSent: true, domains: ['comcast.net'], note: 'Turn on third-party access in Xfinity email settings first.' },
  { id: 'att', name: 'AT&T Mail', imap: tls('imap.mail.att.net'), smtp: smtps('smtp.mail.att.net'), appendSent: true, domains: ['att.net', 'sbcglobal.net', 'bellsouth.net'], note: 'Needs a secure mail key from AT&T instead of your password.' },
  { id: 'privateemail', name: 'Namecheap Private Email', imap: tls('mail.privateemail.com'), smtp: smtps('mail.privateemail.com'), appendSent: true, domains: [] },
  { id: 'hostinger', name: 'Hostinger Email', imap: tls('imap.hostinger.com'), smtp: smtps('smtp.hostinger.com'), appendSent: true, domains: [] },
  { id: 'ionos', name: 'IONOS', imap: tls('imap.ionos.com'), smtp: smtps('smtp.ionos.com'), appendSent: true, domains: [] },
  { id: 'infomaniak', name: 'Infomaniak', imap: tls('mail.infomaniak.com'), smtp: smtps('mail.infomaniak.com'), appendSent: true, domains: ['ik.me', 'ikmail.com'] },
];

/** Microsoft's own domains: these sign in with Microsoft, not a password. */
export const MICROSOFT_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.de', 'hotmail.co.uk', 'live.co.uk'];

const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';

/** The provider an address belongs to, from its domain (null for custom domains). */
export function providerForEmail(email: string): MailProvider | null {
  const d = domainOf(email);
  return d ? (MAIL_PROVIDERS.find((p) => p.domains.includes(d)) ?? null) : null;
}

export const isMicrosoftAddress = (email: string) => MICROSOFT_DOMAINS.includes(domainOf(email));

/** The provider whose servers these are, if any (to show the right choice when editing). */
export function providerForServers(imapHost: string, smtpHost: string): MailProvider | null {
  const i = imapHost.trim().toLowerCase();
  const s = smtpHost.trim().toLowerCase();
  return MAIL_PROVIDERS.find((p) => p.imap.host === i && p.smtp.host === s) ?? null;
}
