// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Server settings an administrator sets in Settings → Server, stored in the database under the
// names of the environment variables they stand for. A variable set in the environment (inline in
// the compose file) wins and shows as locked. Bootstrap values (the secret key, the data folder,
// the address) stay environment-only.

export type ServerSettingType = 'text' | 'number' | 'bool' | 'secret' | 'security';

export interface ServerSettingDef {
  env: string;
  label: string;
  group: 'New mailboxes' | 'Mail cache' | 'Limits and safety' | 'Notifications and updates' | 'Backups';
  type: ServerSettingType;
  /** What applies when nothing is set. */
  fallback: string;
  hint?: string;
  /** Takes effect at once; the others after DreyMail restarts. */
  live?: boolean;
}

export const SERVER_SETTINGS: ServerSettingDef[] = [
  { env: 'DREYMAIL_DEFAULT_ACCOUNT_LABEL', label: 'Mailbox name', group: 'New mailboxes', type: 'text', fallback: '', live: true, hint: 'Templates can use {username}, {email} and {name}, e.g. {username}@example.com.' },
  { env: 'DREYMAIL_DEFAULT_DISPLAY_NAME', label: 'Your name', group: 'New mailboxes', type: 'text', fallback: '', live: true },
  { env: 'DREYMAIL_DEFAULT_EMAIL', label: 'Email address', group: 'New mailboxes', type: 'text', fallback: '', live: true },
  { env: 'DREYMAIL_DEFAULT_IMAP_HOST', label: 'IMAP server', group: 'New mailboxes', type: 'text', fallback: '', live: true },
  { env: 'DREYMAIL_DEFAULT_IMAP_PORT', label: 'IMAP port', group: 'New mailboxes', type: 'number', fallback: '993', live: true },
  { env: 'DREYMAIL_DEFAULT_IMAP_SECURITY', label: 'IMAP security', group: 'New mailboxes', type: 'security', fallback: 'tls', live: true },
  { env: 'DREYMAIL_DEFAULT_SMTP_HOST', label: 'SMTP server', group: 'New mailboxes', type: 'text', fallback: '', live: true },
  { env: 'DREYMAIL_DEFAULT_SMTP_PORT', label: 'SMTP port', group: 'New mailboxes', type: 'number', fallback: '465', live: true },
  { env: 'DREYMAIL_DEFAULT_SMTP_SECURITY', label: 'SMTP security', group: 'New mailboxes', type: 'security', fallback: 'tls', live: true },
  { env: 'DREYMAIL_DEFAULT_MAIL_USERNAME', label: 'Username', group: 'New mailboxes', type: 'text', fallback: '', live: true },
  { env: 'DREYMAIL_DEFAULT_MAIL_PASSWORD', label: 'Password', group: 'New mailboxes', type: 'secret', fallback: '', live: true, hint: 'Used when a new mailbox leaves the password empty (one shared mailbox password). Never shown to users.' },
  { env: 'DREYMAIL_CACHE', label: 'Keep an encrypted copy of recent mail', group: 'Mail cache', type: 'bool', fallback: 'true' },
  { env: 'DREYMAIL_CACHE_MESSAGES', label: 'Messages kept of Inbox and Sent', group: 'Mail cache', type: 'number', fallback: '20000', hint: 'A folder with no more than this is searched instantly once indexed.' },
  { env: 'DREYMAIL_CACHE_FOLDER_MESSAGES', label: 'Messages kept of other folders', group: 'Mail cache', type: 'number', fallback: '10000', hint: '0 keeps only Inbox and Sent. A folder with no more than this is searched instantly once indexed.' },
  { env: 'DREYMAIL_CACHE_MAX_BODY_MB', label: 'Largest message kept whole (MB)', group: 'Mail cache', type: 'number', fallback: '1' },
  { env: 'DREYMAIL_CACHE_USER_MB', label: 'Space per user (MB)', group: 'Mail cache', type: 'number', fallback: '4096', live: true, hint: 'Each user’s cached mail, search index and stored messages, split across their mailboxes (evenly unless they choose otherwise in Settings → Search and storage).' },
  { env: 'DREYMAIL_MAX_MESSAGE_MB', label: 'Largest message opened (MB)', group: 'Limits and safety', type: 'number', fallback: '50' },
  { env: 'DREYMAIL_MAX_UPLOAD_MB', label: 'Largest attachment upload (MB)', group: 'Limits and safety', type: 'number', fallback: '25' },
  { env: 'DREYMAIL_IMAP_IDLE_TIMEOUT', label: 'Close idle mail connections after (seconds)', group: 'Limits and safety', type: 'number', fallback: '300' },
  { env: 'DREYMAIL_BLOCK_PRIVATE_MAIL_HOSTS', label: 'Refuse mail and calendar servers on private networks', group: 'Limits and safety', type: 'bool', fallback: 'false', hint: 'On for a DreyMail open to people you don’t trust: they can’t make it connect to your LAN.' },
  { env: 'DREYMAIL_VAPID_SUBJECT', label: 'Contact for push services', group: 'Notifications and updates', type: 'text', fallback: 'this server’s address', hint: 'A mailto: or https: address that browser push services may contact.' },
  { env: 'DREYMAIL_BACKUP_DAYS', label: 'Keep automatic backups for (days)', group: 'Backups', type: 'number', fallback: '7', live: true, hint: 'A copy of the database every day in the data folder’s backups folder; 0 turns automatic backups off.' },
  { env: 'DREYMAIL_UPDATE_CHECK', label: 'Check GitHub for new DreyMail versions', group: 'Notifications and updates', type: 'bool', fallback: 'true' },
];

export interface ServerSettingView {
  env: string;
  /** Saved in the database ('' = not set; secrets: never sent, see `isSet`). */
  value: string;
  isSet: boolean;
  /** Set in the environment: wins, and the UI shows it locked. */
  fromEnv: boolean;
  /** The environment's value (secrets: empty). */
  envValue: string;
}

export interface ServerSettingsView {
  settings: ServerSettingView[];
  /** Saved changes wait for DreyMail to restart. */
  restartNeeded: boolean;
}
