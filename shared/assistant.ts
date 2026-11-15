// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

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
