// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import type { UnsubscribeOptions } from './unsubscribe.js';

/**
 * The AI mailbox assistant: rules per mailbox, what they do, and the record of what was done.
 * Rules are checked in order and the first that applies wins. A rule's exact conditions (if any)
 * must hold first; a rule with plain-language instructions then asks the AI, a rule without them
 * applies on its conditions alone and costs nothing.
 */

export type RuleAction =
  | { type: 'move'; folder: string }
  | { type: 'label'; name: string }
  | { type: 'archive' }
  | { type: 'read' }
  | { type: 'star' }
  | { type: 'trash' }
  | { type: 'spam' };

export const RULE_ACTION_LABELS: Record<RuleAction['type'], string> = {
  move: 'Move to folder',
  label: 'Add label',
  archive: 'Archive',
  read: 'Mark as read',
  star: 'Star',
  trash: 'Move to Trash',
  spam: 'Mark as spam',
};

export interface RuleConditions {
  /** Sender name or address contains (case-insensitive). */
  from?: string;
  /** A recipient contains. */
  to?: string;
  /** Subject contains. */
  subject?: string;
  hasAttachment?: boolean;
}

export interface AssistantRule {
  id: string;
  name: string;
  /** Plain-language description of the mail this rule is for; '' = conditions only. */
  instructions: string;
  conditions: RuleConditions;
  actions: RuleAction[];
  enabled: boolean;
}

export type RuleInput = Omit<AssistantRule, 'id'>;

export interface MailboxAssistantSettings {
  accountId: string;
  /** The assistant acts on new mail in this mailbox. */
  enabled: boolean;
  connectionId: string | null;
  /** 1–4, see ACCURACY_LEVELS in shared/aiProviders.ts. */
  accuracy: number;
}

/** Learning mode of a mailbox. */
export interface LearningStatus {
  /** ISO times; null when learning was never started. */
  from: string | null;
  until: string | null;
  active: boolean;
  /** Ended and its suggestions not reviewed yet. */
  reviewDue: boolean;
  observations: number;
}

export const LEARNING_PERIODS = [
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
] as const;

/** A rule learning mode proposes, with the evidence for it. */
export interface RuleSuggestion extends RuleInput {
  evidence: string;
}

/** One message the assistant handled (or would handle, in a preview). */
export interface AssistantDecision {
  uid: number;
  uidValidity: string;
  folder: string;
  subject: string;
  from: string;
  date: string;
  ruleId: string | null;
  ruleName: string;
  reason: string;
  actions: RuleAction[];
  error?: string;
}

export interface HistoryEntry extends AssistantDecision {
  id: number;
  at: string;
  source: 'auto' | 'scan' | 'manual';
  /** Can still be undone (moves are moved back, flags restored). */
  undoable: boolean;
  undone: boolean;
}

export interface AssistantStatus {
  /** The user may use the assistant (role permission or a per-user switch). */
  allowed: boolean;
  /** The user accepted the "AI can make mistakes" notice. */
  acceptedTerms: boolean;
}

/** A one-time cleanup of existing mail (progress). */
export interface ScanStatus {
  running: boolean;
  total: number;
  done: number;
  acted: number;
  errors: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Inbox mail of one sender (the senders cleanup). */
export interface SenderGroup {
  address: string;
  name: string;
  count: number;
  unread: number;
  latest: string;
  /** How to unsubscribe, from the List-Unsubscribe header: one-click (RFC 8058), a web page, or an email. */
  unsubscribe: UnsubscribeOptions | null;
}
