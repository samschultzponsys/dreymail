// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

/**
 * AI services the mailbox assistant can use. Three kinds of API cover them all: Anthropic's,
 * Google Gemini's, and the OpenAI-style chat API that OpenAI, DeepSeek, Mistral, Groq, OpenRouter,
 * xAI and local servers (LM Studio, Ollama, vLLM, llama.cpp, LocalAI…) all speak.
 */

export type AiApi = 'anthropic' | 'gemini' | 'openai';

export interface AiPreset {
  id: string;
  label: string;
  api: AiApi;
  baseUrl: string;
  /** Local servers usually need no key. */
  keyRequired: boolean;
  /** Where to get a key (shown as a link). */
  keyUrl?: string;
  /** Models to suggest for sorting mail: fast and inexpensive first. */
  suggestions: { model: string; note: string }[];
  /** A local server on your own machine or network. */
  local?: boolean;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyRequired: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    suggestions: [
      { model: 'claude-haiku-5-5', note: 'Recommended for sorting mail: fast and very inexpensive' },
      { model: 'claude-sonnet-5-5', note: 'Smarter, for tricky rules; costs about 20 times more' },
      { model: 'claude-opus-5-5', note: 'Most capable; rarely needed for sorting mail' },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyRequired: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    suggestions: [{ model: '', note: 'Pick a "Flash" or "Flash-Lite" model from Load models: fast and inexpensive' }],
  },
  {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    suggestions: [{ model: '', note: 'Pick a "mini" or "nano" model from Load models: fast and inexpensive' }],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyRequired: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    suggestions: [{ model: 'deepseek-chat', note: 'Inexpensive general model' }],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    api: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyRequired: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    suggestions: [{ model: '', note: 'Pick a "small" model from Load models' }],
  },
  {
    id: 'groq',
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    keyUrl: 'https://console.groq.com/keys',
    suggestions: [{ model: '', note: 'Very fast open models; pick one from Load models' }],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many providers, one key)',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    keyUrl: 'https://openrouter.ai/keys',
    suggestions: [{ model: '', note: 'Pick any model from Load models; inexpensive "mini"/"flash"/"haiku" models are plenty' }],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    api: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyRequired: true,
    keyUrl: 'https://console.x.ai',
    suggestions: [{ model: '', note: 'Pick a "mini"/"fast" model from Load models' }],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    api: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    keyRequired: false,
    local: true,
    suggestions: [{ model: '', note: 'Any instruction model you have loaded; 7–14B models sort mail well' }],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    api: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    local: true,
    suggestions: [{ model: '', note: 'Any instruction model you have pulled; 7–14B models sort mail well' }],
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible server (vLLM, llama.cpp, LocalAI, …)',
    api: 'openai',
    baseUrl: '',
    keyRequired: false,
    suggestions: [],
  },
];

export const presetFor = (id: string): AiPreset | undefined => AI_PRESETS.find((p) => p.id === id);

/** An AI connection as the web app sees it (the key is never sent back). */
export interface AiConnectionView {
  id: string;
  name: string;
  preset: string;
  api: AiApi;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Most AI requests per day (0 = no limit). */
  dailyLimit: number;
  /** Shared by an administrator with everyone allowed to use it. */
  shared: boolean;
  /** Mailboxes (of the current user) that use it. */
  accountIds: string[];
  /** Requests made today. */
  usedToday: number;
}

/**
 * What the AI sees of each message, from most to least (the accuracy slider). Default: full.
 */
export const ACCURACY_LEVELS = [
  { level: 1, label: 'Private', sees: 'Sender and subject only' },
  { level: 2, label: 'Balanced', sees: 'Sender, recipients, subject and the first lines (about 300 characters)' },
  { level: 3, label: 'High', sees: 'Sender, recipients, subject and the first part of the message (about 2,000 characters)' },
  { level: 4, label: 'Full', sees: 'Sender, recipients, subject, the whole message text (up to about 12,000 characters) and attachment names' },
] as const;

export const README_AI_URL = (version: string) => `https://github.com/samschultzponsys/dreymail/blob/v${version}/README.md#ai-mailbox-assistant`;
