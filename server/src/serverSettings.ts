// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Server settings set in the UI (shared/serverSettings.ts), stored in the database as the values
// of the environment variables they stand for. The running configuration is the environment over
// the stored values, checked by loadConfig as if they had all been in the environment.

import { SERVER_SETTINGS, type ServerSettingsView } from '../../shared/serverSettings.js';
import { loadConfig, type Config } from './config.js';
import type { Store } from './db.js';

const KEY = 'server';
const SECRET = 'DREYMAIL_DEFAULT_MAIL_PASSWORD';
const NAMES = new Set(SERVER_SETTINGS.map((s) => s.env));

export class ServerSettingsError extends Error {}

const isSet = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '') !== '';

/** What is stored, secrets opened. Unknown or broken entries are left out. */
export function storedServerSettings(store: Store): Record<string, string> {
  const raw = store.getSetting<Record<string, string>>(KEY) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!NAMES.has(k) || typeof v !== 'string' || v === '') continue;
    if (k === SECRET) {
      try {
        out[k] = store.openSecret(KEY, v);
      } catch {
        /* e.g. the secret key changed */
      }
    } else out[k] = v;
  }
  return out;
}

/** The configuration with the stored settings under the environment (the environment wins). */
export function withStoredSettings(config: Config, store: Store, log?: (msg: string) => void): Config {
  const stored = storedServerSettings(store);
  if (!Object.keys(stored).length) return config;
  try {
    return { ...loadConfig({ ...stored, ...config.sourceEnv }), sourceEnv: config.sourceEnv };
  } catch (err) {
    log?.(`Server settings saved in the UI are ignored: ${(err as Error).message}`);
    return config;
  }
}

export class ServerSettings {
  /** What the running server started with (to tell when a restart is needed). */
  private readonly running: Record<string, string>;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.running = storedServerSettings(store);
  }

  view(): ServerSettingsView {
    const stored = storedServerSettings(this.store);
    const env = this.config.sourceEnv;
    return {
      settings: SERVER_SETTINGS.map((s) => ({
        env: s.env,
        value: s.type === 'secret' ? '' : (stored[s.env] ?? ''),
        isSet: !!stored[s.env],
        fromEnv: isSet(env, s.env),
        envValue: s.type === 'secret' || !isSet(env, s.env) ? '' : String(env[s.env]),
      })),
      restartNeeded: SERVER_SETTINGS.some((s) => !s.live && !isSet(env, s.env) && (stored[s.env] ?? '') !== (this.running[s.env] ?? '')),
    };
  }

  /**
   * Saves settings (a value of '' clears one; for the password, null keeps it). Checked as the
   * environment would be; settings that apply at once are applied to the running configuration.
   */
  save(values: Record<string, string | null>): ServerSettingsView {
    const next = { ...storedServerSettings(this.store) };
    for (const [k, v] of Object.entries(values)) {
      if (!NAMES.has(k)) throw new ServerSettingsError(`Unknown setting ${k}`);
      if (v === null) continue;
      if (v.length > 2000) throw new ServerSettingsError('That value is too long');
      if (v === '') delete next[k];
      else next[k] = k === SECRET ? v : v.trim();
    }
    let checked: Config;
    try {
      checked = loadConfig({ ...next, ...this.config.sourceEnv });
    } catch (err) {
      const lines = (err as Error).message.split('\n').slice(1).map((l) => l.replace(/^\s*-\s*/, ''));
      // Only problems with what can be set here: a broken environment isn't the admin's typo.
      const ours = lines.filter((l) => [...NAMES].some((n) => l.includes(n)));
      throw new ServerSettingsError(ours.join(' ') || (err as Error).message);
    }
    const sealed: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) sealed[k] = k === SECRET ? this.store.sealSecret(KEY, v) : v;
    this.store.setSetting(KEY, sealed);
    // New mailboxes' starting values apply at once.
    this.config.accountDefaults = checked.accountDefaults;
    return this.view();
  }
}
