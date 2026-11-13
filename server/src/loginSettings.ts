// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Sign-in options (OIDC, password login, registration), set by an administrator in the UI and
// stored in the database. A value given as an environment variable (inline in the compose file)
// always wins over the UI and shows there as locked. Without either, the upstream defaults apply.

import type { LoginSettingsInput, LoginSettingsView, Registration } from '../../shared/types.js';
import { LOGIN_ENV_NAMES, type Config } from './config.js';
import type { Store } from './db.js';

/** What's stored in the database (instance_settings 'login'); the secret is encrypted. */
interface StoredLogin {
  oidcEnabled?: boolean;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  label?: string;
  passwordLogin?: boolean;
  registration?: Registration;
}

export interface EffectiveLogin {
  oidc: Config['oidc'];
  passwordLogin: boolean;
  registration: Registration;
}

export class LoginSettingsError extends Error {}

const KEY = 'login';
const DEFAULT_SCOPES = 'openid email profile';
const DEFAULT_LABEL = 'Single sign-on';

export class LoginSettings {
  private effective: EffectiveLogin;
  private listeners: (() => void)[] = [];

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.effective = this.compute(this.stored());
  }

  current(): EffectiveLogin {
    return this.effective;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private stored(): StoredLogin {
    const s = this.store.getSetting<StoredLogin>(KEY) ?? {};
    if (s.clientSecret) {
      try {
        s.clientSecret = this.store.openSecret(KEY, s.clientSecret);
      } catch {
        s.clientSecret = ''; // e.g. the secret key changed
      }
    }
    return s;
  }

  private compute(s: StoredLogin): EffectiveLogin {
    const env = this.config.loginEnv;
    const issuerUrl = env.issuerUrl ?? s.issuerUrl ?? '';
    const clientId = env.clientId ?? s.clientId ?? '';
    // OIDC set in the environment is on; set in the UI, it is on when switched on there.
    const oidcOn = (env.issuerUrl !== undefined || !!s.oidcEnabled) && !!issuerUrl && !!clientId;
    const oidc = oidcOn
      ? {
          issuerUrl,
          clientId,
          clientSecret: env.clientSecret ?? s.clientSecret ?? '',
          scopes: env.scopes ?? (s.scopes || DEFAULT_SCOPES),
          label: env.label ?? (s.label?.trim() || DEFAULT_LABEL),
        }
      : null;
    // Without OIDC, password login is on unless switched off explicitly.
    const passwordLogin = env.passwordLogin ?? s.passwordLogin ?? !oidc;
    return { oidc, passwordLogin, registration: env.registration ?? s.registration ?? 'first' };
  }

  view(): LoginSettingsView {
    const s = this.stored();
    const env = this.config.loginEnv;
    const e = this.effective;
    const locked: LoginSettingsView['locked'] = {};
    for (const [field, name] of Object.entries(LOGIN_ENV_NAMES) as [keyof typeof LOGIN_ENV_NAMES, string][]) {
      if (env[field] !== undefined) locked[field] = name;
    }
    if (env.issuerUrl !== undefined) locked.oidcEnabled = LOGIN_ENV_NAMES.issuerUrl;
    return {
      oidcEnabled: e.oidc !== null || (env.issuerUrl === undefined && !!s.oidcEnabled),
      issuerUrl: env.issuerUrl ?? s.issuerUrl ?? '',
      clientId: env.clientId ?? s.clientId ?? '',
      hasClientSecret: !!(env.clientSecret ?? s.clientSecret),
      scopes: env.scopes ?? (s.scopes || DEFAULT_SCOPES),
      label: env.label ?? (s.label || DEFAULT_LABEL),
      passwordLogin: e.passwordLogin,
      registration: e.registration,
      locked,
      callbackUrl: new URL('/auth/callback', this.config.baseUrl).toString(),
    };
  }

  /** What saving this input would result in, checked; throws LoginSettingsError. */
  preview(input: LoginSettingsInput): { stored: StoredLogin; effective: EffectiveLogin } {
    const old = this.stored();
    const clientSecret = input.clearClientSecret ? '' : input.clientSecret || old.clientSecret || '';
    const stored: StoredLogin = {
      oidcEnabled: input.oidcEnabled,
      issuerUrl: input.issuerUrl.trim(),
      clientId: input.clientId.trim(),
      clientSecret,
      scopes: input.scopes.trim(),
      label: input.label.trim(),
      passwordLogin: input.passwordLogin,
      registration: input.registration,
    };
    const env = this.config.loginEnv;
    if (input.oidcEnabled && env.issuerUrl === undefined) {
      try {
        const u = new URL(stored.issuerUrl!);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        throw new LoginSettingsError('Issuer URL must be an http(s) URL');
      }
      if (!(env.clientId ?? stored.clientId)) throw new LoginSettingsError('Client ID is required for OIDC');
    }
    const effective = this.compute(stored);
    if (!effective.oidc && !effective.passwordLogin && !this.config.devLogin) {
      throw new LoginSettingsError('Keep at least one way to sign in: OIDC or username and password');
    }
    return { stored, effective };
  }

  save(input: LoginSettingsInput): EffectiveLogin {
    const { stored, effective } = this.preview(input);
    this.store.setSetting(KEY, { ...stored, clientSecret: stored.clientSecret ? this.store.sealSecret(KEY, stored.clientSecret) : '' });
    this.effective = effective;
    for (const fn of this.listeners) fn();
    return effective;
  }
}
