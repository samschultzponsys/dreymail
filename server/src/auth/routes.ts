// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: sign-in options come from LoginSettings (UI, with environment overrides) and can change at runtime.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-15: source code link (AGPL §13) with attribution.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.
// Modified by samschultzponsys, 2026-11-15: automatic single sign-on, with /login to get to the sign-in page.
// Modified by samschultzponsys, 2026-11-15: connecting single sign-on to an existing account.
// Modified by samschultzponsys, 2026-11-17: connecting single sign-on removes the password; disconnecting sets a new one.

import { serverVersion } from '../version.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AuthMethods, SsoStatus } from '../../../shared/types.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { EffectiveLogin, LoginSettings } from '../loginSettings.js';
import { burnPasswordCheck, FailureLimiter, hashPassword, LOCAL_ISSUER, passwordSchema, usernameSchema, verifyPassword } from './password.js';
import type { Sessions } from './session.js';

/** May a new password account be created right now? */
export function registrationOpen(login: EffectiveLogin, store: Store): boolean {
  if (!login.passwordLogin) return false;
  if (login.registration === 'open') return true;
  return login.registration === 'first' && store.countUsers() === 0;
}

/**
 * Two ways in, usable side by side:
 *
 * - Generic OpenID Connect login (authorization code flow with PKCE, state and nonce). Works with
 *   any standards-compliant provider (Authentik, Keycloak, ...). Users are keyed by (issuer, sub).
 * - Username and password (scrypt hashes in SQLite), with optional self-registration.
 */
export async function registerAuthRoutes(app: FastifyInstance, config: Config, store: Store, sessions: Sessions, login: LoginSettings) {
  const callbackUrl = new URL('/auth/callback', config.baseUrl);
  let configPromise: Promise<oidc.Configuration> | null = null;
  // Sign-in settings changed in the UI: discover the (possibly different) provider again.
  login.onChange(() => {
    configPromise = null;
  });

  const getConfig = () => {
    const o = login.current().oidc;
    if (!o) throw new Error('OIDC is not configured');
    configPromise ??= oidc
      .discovery(new URL(o.issuerUrl), o.clientId, o.clientSecret || undefined, undefined, {
        execute: !config.production && o.issuerUrl.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
      })
      .catch((err: unknown) => {
        configPromise = null; // retry discovery on the next attempt
        throw err;
      });
    return configPromise;
  };

  app.get('/auth/methods', async (): Promise<AuthMethods> => {
    const l = login.current();
    return {
      password: l.passwordLogin,
      registration: registrationOpen(l, store),
      oidc: l.oidc ? { label: l.oidc.label, auto: l.oidcAutoLogin } : null,
      dev: config.devLogin,
      version: serverVersion(),
      passkeys: !!store.db.prepare('SELECT 1 FROM passkeys LIMIT 1').get(),
    };
  });

  app.get<{ Querystring: { link?: string } }>('/auth/login', async (req, reply) => {
    const o = login.current().oidc;
    // ?link=1: connect single sign-on to the account that is signed in now.
    const linking = req.query.link === '1' ? sessions.read(req) : null;
    if (req.query.link === '1' && !linking) return reply.redirect('/login');
    if (!o) return reply.redirect(config.devLogin ? '/auth/dev-login' : '/login');
    let cfg: Awaited<ReturnType<typeof getConfig>>;
    try {
      cfg = await getConfig();
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'OIDC provider unreachable');
      return reply.redirect(`/login?${new URLSearchParams({ error: `Couldn't reach ${o.label}. Try again in a moment, or sign in another way.` })}`);
    }
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    sessions.writeLogin(reply, { state, nonce, verifier, ...(linking ? { link: linking.uid } : {}) });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: callbackUrl.toString(),
      scope: o.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, reply) => {
    const tx = sessions.takeLogin(req, reply);
    // Back to the sign-in page with the reason (never straight back to the provider, so a broken
    // provider can't cause a redirect loop with automatic sign-in).
    const failed = (message: string) => reply.redirect(`/login?${new URLSearchParams({ error: message })}`);
    const providerError = (req.query as { error?: string; error_description?: string }).error;
    if (providerError) return failed(`Single sign-on said: ${((req.query as { error_description?: string }).error_description ?? providerError).slice(0, 200)}`);
    if (!tx) return failed('That sign-in took too long or was started elsewhere. Please try again.');
    try {
      const cfg = await getConfig();
      // Rebuild the callback URL from the configured base URL, not from request headers.
      const current = new URL(req.url, config.baseUrl);
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('ID token has no subject');
      if (tx.link) {
        // Connecting: only for the account that started it, still signed in on this browser.
        const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams(params)}`);
        const session = sessions.read(req);
        if (!session || session.uid !== tx.link || !store.getUser(tx.link)) return back({ sso: 'error', message: 'Sign in to DreyMail first, then connect single sign-on again.' });
        const me = store.getUser(tx.link)!;
        if (me.issuer === claims.iss && me.subject === claims.sub) return back({ sso: 'connected' });
        store.connectIdentity(tx.link, claims.iss, claims.sub);
        // From now on the account signs in with single sign-on (or a passkey), not a password.
        store.clearPassword(tx.link);
        req.log.info({ user: tx.link }, 'single sign-on connected to an account');
        return back({ sso: 'connected' });
      }
      let email = typeof claims.email === 'string' ? claims.email : '';
      let name = typeof claims.name === 'string' ? claims.name : '';
      let username = typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
      if ((!email || !name || !username) && tokens.access_token) {
        try {
          const info = await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub);
          email ||= typeof info.email === 'string' ? info.email : '';
          username ||= typeof info.preferred_username === 'string' ? info.preferred_username : '';
          name ||= typeof info.name === 'string' ? info.name : username;
        } catch {
          /* userinfo is optional */
        }
      }
      const user = store.upsertUser(claims.iss, claims.sub, email, name || email || claims.sub, username.trim());
      sessions.write(reply, { uid: user.id, via: 'oidc', idt: tokens.id_token && tokens.id_token.length < 2500 ? tokens.id_token : undefined });
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'OIDC callback failed');
      if (tx.link) return reply.redirect(`/?${new URLSearchParams({ sso: 'error', message: 'Connecting single sign-on failed. Please try again.' })}`);
      return failed('Single sign-on failed. Please try again, or ask your administrator.');
    }
  });

  // ---- connecting single sign-on to an existing account (signed in; /api checks the session) ----

  app.get('/api/sso', async (req): Promise<SsoStatus> => {
    const me = req.user!;
    const o = login.current().oidc;
    const ids = store.identitiesOf(me.id);
    const ownOidc = !me.hasPassword && me.issuer !== 'dev-login';
    const hasPasskey = !!store.db.prepare('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1').get(me.id);
    const needsPassword = !me.hasPassword && !hasPasskey;
    return {
      available: !!o,
      label: o?.label ?? '',
      connected: ownOidc || ids.length > 0,
      connectedAt: ids[0] ? new Date(ids[0].createdAt).toISOString() : null,
      // Disconnecting must leave a way in: a passkey, or a new password (only for username accounts,
      // and only connected identities can go).
      canDisconnect: ids.length > 0 && (!needsPassword || me.issuer === LOCAL_ISSUER),
      needsPassword,
    };
  });

  app.delete('/api/sso', async (req, reply) => {
    const me = req.user!;
    if (store.identitiesOf(me.id).length === 0) return reply.code(400).send({ error: 'Single sign-on is not connected to this account.' });
    const hasPasskey = !!store.db.prepare('SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1').get(me.id);
    const given = z.object({ password: z.string().max(1000).optional() }).safeParse(req.body ?? {});
    const password = given.success && given.data.password ? given.data.password : '';
    if (password || (!me.hasPassword && !hasPasskey)) {
      // A new password, so the account can still sign in once single sign-on is gone.
      if (me.issuer !== LOCAL_ISSUER) return reply.code(400).send({ error: 'Add a passkey first, so you can still sign in.' });
      if (!password) return reply.code(400).send({ error: 'Choose a new password, so you can still sign in.' });
      const valid = passwordSchema.safeParse(password);
      if (!valid.success) return reply.code(400).send({ error: valid.error.issues[0]!.message });
      store.setNewPasswordHash(me.id, await hashPassword(valid.data));
    }
    store.disconnectIdentities(me.id);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const session = sessions.read(req);
    sessions.clear(reply);
    let redirect = '/';
    if (login.current().oidc && session && (session.via ?? 'oidc') === 'oidc') {
      try {
        const cfg = await getConfig();
        if (cfg.serverMetadata().end_session_endpoint) {
          redirect = oidc
            .buildEndSessionUrl(cfg, {
              post_logout_redirect_uri: new URL('/', config.baseUrl).toString(),
              ...(session.idt ? { id_token_hint: session.idt } : {}),
            })
            .toString();
        }
      } catch {
        /* fall back to local logout */
      }
    }
    return { redirect };
  });

  if (config.devLogin) {
    app.log.warn('DREYMAIL_DEV_LOGIN is enabled: anyone can log in as the local dev user. Never use this in production.');
    app.get('/auth/dev-login', async (_req, reply) => {
      const user = store.upsertUser('dev-login', 'dev', 'user@example.com', 'Dev User', 'dev');
      sessions.write(reply, { uid: user.id, via: 'dev' });
      return reply.redirect('/');
    });
  }

  // Always registered: password login can be switched on and off in the UI at any time.
  registerPasswordRoutes(app, store, sessions, login);
}

const credentialsSchema = z.object({ username: z.string().max(500), password: z.string().max(1000) });

function registerPasswordRoutes(app: FastifyInstance, store: Store, sessions: Sessions, login: LoginSettings) {
  const window = 15 * 60 * 1000;
  const failuresByIp = new FailureLimiter(30, window);
  const failuresByUser = new FailureLimiter(10, window);
  const registrationsByIp = new FailureLimiter(5, 60 * 60 * 1000);

  /** Same CSRF rule as /api: a custom header only our own origin can send. Also stops login CSRF. */
  const parse = (req: FastifyRequest, reply: FastifyReply) => {
    if (!login.current().passwordLogin) {
      void reply.code(404).send({ error: 'Password login is turned off' });
      return null;
    }
    if (req.headers['x-dreymail'] !== '1') {
      void reply.code(403).send({ error: 'Missing CSRF header' });
      return null;
    }
    const body = credentialsSchema.safeParse(req.body);
    if (!body.success) {
      void reply.code(400).send({ error: 'Username and password are required' });
      return null;
    }
    return body.data;
  };

  app.post('/auth/password/login', async (req, reply) => {
    const body = parse(req, reply);
    if (!body) return reply;
    const username = usernameSchema.safeParse(body.username);
    const userKey = username.success ? username.data : body.username.toLowerCase();
    if (failuresByIp.blocked(req.ip) || failuresByUser.blocked(userKey)) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const found = username.success ? store.findPasswordUser(LOCAL_ISSUER, username.data) : null;
    const ok = found ? await verifyPassword(body.password, found.passwordHash) : (await burnPasswordCheck(body.password), false);
    if (!found || !ok) {
      failuresByIp.fail(req.ip);
      failuresByUser.fail(userKey);
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    failuresByUser.reset(userKey);
    sessions.write(reply, { uid: found.user.id, via: 'password' });
    return { ok: true };
  });

  app.post('/auth/password/register', async (req, reply) => {
    const body = parse(req, reply);
    if (!body) return reply;
    if (!registrationOpen(login.current(), store)) return reply.code(403).send({ error: 'Registration is closed' });
    if (registrationsByIp.blocked(req.ip)) {
      return reply.code(429).send({ error: 'Too many new accounts from this address. Try again later.' });
    }
    const username = usernameSchema.safeParse(body.username);
    if (!username.success) return reply.code(400).send({ error: username.error.issues[0]!.message });
    const password = passwordSchema.safeParse(body.password);
    if (!password.success) return reply.code(400).send({ error: password.error.issues[0]!.message });
    const hash = await hashPassword(password.data);
    // Checked again after the (slow) hash: in `first` mode two concurrent sign-ups must not both win.
    if (!registrationOpen(login.current(), store)) return reply.code(403).send({ error: 'Registration is closed' });
    const user = store.createPasswordUser(LOCAL_ISSUER, username.data, hash);
    if (!user) return reply.code(409).send({ error: 'That username is taken' });
    registrationsByIp.fail(req.ip);
    sessions.write(reply, { uid: user.id, via: 'password' });
    return { ok: true };
  });
}
