// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: signature API calls.
// Modified by samschultzponsys, 2026-11-13: administration API calls.
// Modified by samschultzponsys, 2026-11-13: DreyMail's own names (env vars, identifiers, comments).
// Modified by samschultzponsys, 2026-11-13: Android app: notifications and Firebase settings.
// Modified by samschultzponsys, 2026-11-13: your name; interface size.
// Modified by samschultzponsys, 2026-11-13: version and changelog at the bottom left; first name only by default.
// Modified by samschultzponsys, 2026-11-15: Outlook accounts; This device settings.
// Modified by samschultzponsys, 2026-11-15: Sign in with Google for Gmail.
// Modified by samschultzponsys, 2026-11-15: search filters and saved searches.
// Modified by samschultzponsys, 2026-11-15: roles, permissions and profile pictures.
// Modified by samschultzponsys, 2026-11-15: your own picture as a mailbox icon.
// Modified by samschultzponsys, 2026-11-15: AI mailbox assistant.
// Modified by samschultzponsys, 2026-11-15: copy codes, unsubscribe, block sender, mailbox health.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-15: passkey sign-in.

import type { AiConnectionView } from '../../shared/aiProviders';
import type { AssistantDecision, AssistantRule, HistoryEntry, MailboxAssistantSettings, RuleInput, RuleSuggestion, ScanStatus, SenderGroup, LearningStatus } from '../../shared/assistant';
import type { Permission, Role } from '../../shared/permissions';

export interface AiConnectionInput {
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearKey?: boolean;
  dailyLimit: number;
  shared: boolean;
}
import type { SavedSearch } from '../../shared/search';

export interface RolesView {
  roles: Role[];
  defaultRole: string;
}
import type { MailboxGroupInput, MailboxGroupView, AccountFolders, AccountInput, AccountView, ActionResult, AdminUser, AuthMethods, ComposePayload, DomainName, DraftResult, FirebaseSettingsView, GoogleSettingsView, ListResponse, LoginSettingsInput, LoginSettingsView, Me, MessageAction, MessageDetail, MessageRef, MicrosoftSettingsView, Preferences, PushSubscriptionInput, ScheduledSend, SendResult, Signature, SignatureInput, VersionInfo } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stale = false,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-dreymail': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = res.statusText;
    let stale = false;
    try {
      const j = (await res.json()) as { error?: string; stale?: boolean };
      msg = j.error ?? msg;
      stale = !!j.stale;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status, stale);
  }
  return (await res.json()) as T;
}

export const refQuery = (r: MessageRef) =>
  `accountId=${encodeURIComponent(r.accountId)}&folder=${encodeURIComponent(r.folder)}&uid=${r.uid}&uidValidity=${r.uidValidity}`;

export interface MailboxSel {
  /** null = unified inbox */
  accountId: string | null;
  folder: string;
}

export type RemoteMode = 'auto' | 'load' | 'block';

/** Until when first pages of message lists ask the server to check with the mail server first (after Refresh). */
let freshUntil = 0;

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  savePreferences: (p: Preferences) => request<Preferences>('PUT', '/api/preferences', p),
  saveName: (name: string) => request<{ name: string }>('PUT', '/api/me/name', { name }),
  version: () => request<VersionInfo>('GET', '/api/version'),
  microsoftAvailable: () => request<{ available: boolean }>('GET', '/api/oauth/microsoft'),
  googleAvailable: () => request<{ available: boolean }>('GET', '/api/oauth/google'),
  startGoogle: (color: string) => request<{ url: string }>('POST', '/api/oauth/google/start', { color }),
  adminGoogle: () => request<GoogleSettingsView>('GET', '/api/admin/google'),
  adminSaveGoogle: (s: { clientId: string; clientSecret: string }) => request<GoogleSettingsView>('PUT', '/api/admin/google', s),
  startMicrosoft: (color: string) => request<{ url: string }>('POST', '/api/oauth/microsoft/start', { color }),
  adminMicrosoft: () => request<MicrosoftSettingsView>('GET', '/api/admin/microsoft'),
  adminSaveMicrosoft: (s: { clientId: string; clientSecret: string; tenant: string; secretExpires?: string | null }) => request<MicrosoftSettingsView>('PUT', '/api/admin/microsoft', s),
  changelog: () => request<{ markdown: string }>('GET', '/api/changelog'),
  logout: () => request<{ redirect: string }>('POST', '/auth/logout'),
  authMethods: () => request<AuthMethods>('GET', '/auth/methods'),
  passwordLogin: (username: string, password: string) => request<{ ok: true }>('POST', '/auth/password/login', { username, password }),
  register: (username: string, password: string) => request<{ ok: true }>('POST', '/auth/password/register', { username, password }),
  changePassword: (current: string, next: string) => request<{ ok: true }>('PUT', '/api/password', { current, next }),

  accounts: () => request<AccountView[]>('GET', '/api/accounts'),
  groups: () => request<MailboxGroupView[]>('GET', '/api/groups'),
  saveGroup: (g: MailboxGroupInput, id?: string) => request<MailboxGroupView[]>(id ? 'PUT' : 'POST', id ? `/api/groups/${encodeURIComponent(id)}` : '/api/groups', g),
  deleteGroup: (id: string) => request<MailboxGroupView[]>('DELETE', `/api/groups/${encodeURIComponent(id)}`),
  testAccount: (account: AccountInput, id?: string) => request<{ ok: true }>('POST', '/api/accounts/test', { account, id }),
  createAccount: (a: AccountInput) => request<AccountView>('POST', '/api/accounts', a),
  updateAccount: (id: string, a: AccountInput) => request<AccountView>('PUT', `/api/accounts/${encodeURIComponent(id)}`, a),
  deleteAccount: (id: string) => request<{ ok: true }>('DELETE', `/api/accounts/${encodeURIComponent(id)}`),
  signatures: () => request<Signature[]>('GET', '/api/signatures'),
  adminUsers: () => request<AdminUser[]>('GET', '/api/admin/users'),
  adminFirebase: () => request<FirebaseSettingsView>('GET', '/api/admin/firebase'),
  adminSaveFirebase: (s: { serviceAccount: string; apiKey: string; appId: string; senderId: string }) => request<FirebaseSettingsView>('PUT', '/api/admin/firebase', s),
  androidPush: () => request<{ firebase: { projectId: string; apiKey: string; appId: string; senderId: string } | null }>('GET', '/api/push/android'),
  registerAndroidToken: (token: string, keys: { p256dh: string; auth: string }) => request<{ ok: true }>('POST', '/api/push/android', { token, keys }),
  adminCreateUser: (u: { username: string; password: string; roleId?: string }) => request<AdminUser[]>('POST', '/api/admin/users', u),
  adminPatchUser: (id: string, patch: { roleId?: string; password?: string; aiAccess?: '' | 'on' | 'off' }) => request<AdminUser[]>('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, patch),
  adminSetPicture: (id: string, image: string) => request<AdminUser[]>('PUT', `/api/admin/users/${encodeURIComponent(id)}/picture`, { image }),
  adminDeletePicture: (id: string) => request<AdminUser[]>('DELETE', `/api/admin/users/${encodeURIComponent(id)}/picture`),
  adminRoles: () => request<RolesView>('GET', '/api/admin/roles'),
  adminSaveRole: (id: string | null, r: { name: string; permissions: Permission[] }) =>
    request<RolesView>(id ? 'PUT' : 'POST', id ? `/api/admin/roles/${encodeURIComponent(id)}` : '/api/admin/roles', r),
  adminDeleteRole: (id: string) => request<RolesView>('DELETE', `/api/admin/roles/${encodeURIComponent(id)}`),
  adminDefaultRole: (roleId: string) => request<RolesView>('PUT', '/api/admin/roles-default', { roleId }),
  unsubscribe: (oneClick: string) => request<{ ok: true }>('POST', '/api/unsubscribe', { oneClick }),
  blocked: () => request<{ accountId: string; address: string; createdAt: string }[]>('GET', '/api/blocked'),
  block: (accountId: string, address: string) => request<{ moved: number }>('POST', '/api/blocked', { accountId, address }),
  unblock: (accountId: string, address: string) => request<{ accountId: string; address: string; createdAt: string }[]>('DELETE', '/api/blocked', { accountId, address }),

  // AI mailbox assistant
  assistantStatus: () => request<{ allowed: boolean; acceptedTerms: boolean; canShare: boolean }>('GET', '/api/assistant/status'),
  acceptAssistantTerms: () => request<{ ok: true }>('POST', '/api/assistant/terms'),
  aiConnections: () => request<AiConnectionView[]>('GET', '/api/assistant/connections'),
  saveAiConnection: (id: string | null, c: AiConnectionInput) =>
    request<AiConnectionView[]>(id ? 'PUT' : 'POST', id ? `/api/assistant/connections/${encodeURIComponent(id)}` : '/api/assistant/connections', c),
  deleteAiConnection: (id: string) => request<AiConnectionView[]>('DELETE', `/api/assistant/connections/${encodeURIComponent(id)}`),
  aiConnectionMailboxes: (id: string, accountIds: string[]) => request<AiConnectionView[]>('PUT', `/api/assistant/connections/${encodeURIComponent(id)}/mailboxes`, { accountIds }),
  aiModels: (t: { id?: string; preset: string; baseUrl: string; apiKey: string }) => request<{ models: string[] }>('POST', '/api/assistant/connections/models', t),
  aiTest: (t: { id?: string; preset: string; baseUrl: string; apiKey: string; model: string }) => request<{ ok: boolean }>('POST', '/api/assistant/connections/test', t),
  assistantMailbox: (accountId: string) => request<{ settings: MailboxAssistantSettings; rules: AssistantRule[] }>('GET', `/api/assistant/mailbox/${encodeURIComponent(accountId)}`),
  saveAssistantSettings: (accountId: string, s: Omit<MailboxAssistantSettings, 'accountId'>) =>
    request<MailboxAssistantSettings>('PUT', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/settings`, s),
  saveAssistantRule: (accountId: string, id: string | null, r: RuleInput) =>
    request<AssistantRule[]>(id ? 'PUT' : 'POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/rules${id ? `/${encodeURIComponent(id)}` : ''}`, r),
  deleteAssistantRule: (accountId: string, id: string) => request<AssistantRule[]>('DELETE', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/rules/${encodeURIComponent(id)}`),
  orderAssistantRules: (accountId: string, ids: string[]) => request<AssistantRule[]>('PUT', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/rules-order`, { ids }),
  assistantPreview: (accountId: string, limit: number, rule?: RuleInput) =>
    request<{ decisions: AssistantDecision[] }>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/preview`, { limit, ...(rule ? { rule } : {}) }),
  assistantApply: (accountId: string, d: AssistantDecision) =>
    request<{ ok: true }>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/apply`, { ruleId: d.ruleId, folder: d.folder, uidValidity: d.uidValidity, uid: d.uid, subject: d.subject, from: d.from }),
  assistantReviewsDue: () => request<string[]>('GET', '/api/assistant/reviews-due'),
  assistantLearning: (accountId: string) => request<LearningStatus>('GET', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/learning`),
  assistantStartLearning: (accountId: string, days: number) => request<LearningStatus>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/learning`, { days }),
  assistantStopLearning: (accountId: string) => request<LearningStatus>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/learning/stop`),
  assistantSuggest: (accountId: string) => request<{ suggestions: RuleSuggestion[] }>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/learning/suggest`),
  assistantReview: (accountId: string, what: 'done' | 'later') => request<LearningStatus>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/learning/${what}`),
  assistantScan: (accountId: string) => request<ScanStatus>('GET', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/scan`),
  assistantStartScan: (accountId: string, limit: number) => request<ScanStatus>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/scan`, { limit }),
  assistantStopScan: (accountId: string) => request<ScanStatus>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/scan/stop`),
  assistantSenders: (accountId: string, limit: number) => request<SenderGroup[]>('GET', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/senders?limit=${limit}`),
  assistantArchiveSender: (accountId: string, address: string) => request<{ archived: number }>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/senders/archive`, { address }),
  assistantUnsubscribe: (accountId: string, oneClick: string) => request<{ ok: true }>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/senders/unsubscribe`, { oneClick }),
  assistantHistory: (accountId: string) => request<HistoryEntry[]>('GET', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/history`),
  assistantUndo: (accountId: string, id: number) => request<HistoryEntry[]>('POST', `/api/assistant/mailbox/${encodeURIComponent(accountId)}/history/${id}/undo`),

  setAccountIcon: (id: string, image: string) => request<AccountView>('PUT', `/api/accounts/${encodeURIComponent(id)}/icon`, { image }),
  deleteAccountIcon: (id: string) => request<AccountView>('DELETE', `/api/accounts/${encodeURIComponent(id)}/icon`),
  setPicture: (image: string) => request<{ avatar: string | null }>('PUT', '/api/me/picture', { image }),
  deletePicture: () => request<{ avatar: string | null }>('DELETE', '/api/me/picture'),
  setGravatar: (on: boolean) => request<{ avatar: string | null }>('PUT', '/api/me/gravatar', { on }),
  adminDeleteUser: (id: string) => request<AdminUser[]>('DELETE', `/api/admin/users/${encodeURIComponent(id)}`),
  adminLogin: () => request<LoginSettingsView>('GET', '/api/admin/login'),
  adminSaveLogin: (s: LoginSettingsInput) => request<LoginSettingsView>('PUT', '/api/admin/login', s),
  adminTestLogin: (s: { issuerUrl: string; clientId: string; clientSecret: string }) => request<{ ok: true; issuer: string }>('POST', '/api/admin/login/test', s),
  createSignature: (s: SignatureInput) => request<Signature>('POST', '/api/signatures', s),
  updateSignature: (id: string, s: SignatureInput) => request<Signature>('PUT', `/api/signatures/${encodeURIComponent(id)}`, s),
  deleteSignature: (id: string) => request<{ ok: true }>('DELETE', `/api/signatures/${encodeURIComponent(id)}`),

  folders: () => request<AccountFolders[]>('GET', '/api/folders'),

  /** The user asked to refresh: the next message lists must not come from a cache that may be behind. */
  requestFresh: () => {
    freshUntil = Date.now() + 5000;
  },

  messages: (sel: MailboxSel, cursor: string | null, q: string, unread: boolean, filter = '') => {
    const p = new URLSearchParams();
    if (sel.accountId) {
      p.set('accountId', sel.accountId);
      p.set('folder', sel.folder);
    }
    if (cursor) p.set('cursor', cursor);
    if (q) p.set('q', q);
    if (unread) p.set('unread', '1');
    if (filter) p.set('filter', filter);
    if (!cursor && Date.now() < freshUntil) p.set('fresh', '1');
    return request<ListResponse>('GET', `/api/messages?${p.toString()}`);
  },
  /** auto: the server applies the sender-domain allowlist; load / block: override it. */
  message: (r: MessageRef, remote: RemoteMode) =>
    request<MessageDetail>('GET', `/api/message?${refQuery(r)}${remote === 'auto' ? '' : `&remote=${remote === 'load' ? 1 : 0}`}`),
  attachmentUrl: (r: MessageRef, index: number) => `/api/attachment?${refQuery(r)}&index=${index}`,
  action: (messages: MessageRef[], action: MessageAction) => request<ActionResult>('POST', '/api/messages/actions', { messages, action }),

  send: (payload: ComposePayload, files: File[], sendAt?: Date) =>
    request<SendResult & { scheduled?: ScheduledSend }>('POST', '/api/send', composeForm(payload, files, sendAt)),
  scheduled: () => request<ScheduledSend[]>('GET', '/api/scheduled'),
  cancelScheduled: (id: string) => request<ScheduledSend[]>('DELETE', `/api/scheduled/${encodeURIComponent(id)}`),
  sendScheduledNow: (id: string) => request<ScheduledSend[]>('POST', `/api/scheduled/${encodeURIComponent(id)}/send`),
  saveDraft: (payload: ComposePayload, files: File[]) => request<DraftResult>('POST', '/api/drafts', composeForm(payload, files)),
  imageDomains: () => request<DomainName[]>('GET', '/api/image-domains'),
  addImageDomain: (domain: string) => request<DomainName[]>('POST', '/api/image-domains', { domain }),
  removeImageDomain: (domain: string) => request<DomainName[]>('DELETE', `/api/image-domains/${encodeURIComponent(domain)}`),

  pushKey: () => request<{ publicKey: string }>('GET', '/api/push'),
  addPushSubscription: (sub: PushSubscriptionInput) => request<{ ok: true }>('POST', '/api/push/subscriptions', sub),
  removePushSubscription: (endpoint: string) => request<{ ok: true }>('DELETE', '/api/push/subscriptions', { endpoint }),
  testPush: () => request<{ delivered: number }>('POST', '/api/push/test'),

  savedSearches: () => request<SavedSearch[]>('GET', '/api/searches'),
  saveSearch: (s: Omit<SavedSearch, 'id'>) => request<SavedSearch[]>('POST', '/api/searches', s),
  deleteSearch: (id: string) => request<SavedSearch[]>('DELETE', `/api/searches/${encodeURIComponent(id)}`),

  recipients: (q: string) => request<{ name: string; address: string }[]>('GET', `/api/recipients?q=${encodeURIComponent(q)}`),
};

function composeForm(payload: ComposePayload, files: File[], sendAt?: Date): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  if (sendAt) form.append('sendAt', sendAt.toISOString());
  for (const f of files) form.append('files', f, f.name);
  return form;
}
export const fetchJson = request;
