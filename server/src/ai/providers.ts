// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// Talks to the AI service of an AI connection (shared/aiProviders.ts): Anthropic through its
// official SDK, Google Gemini and every OpenAI-style server (OpenAI, DeepSeek, Mistral, Groq,
// OpenRouter, LM Studio, Ollama, vLLM, …) with plain HTTPS requests. Every answer is JSON checked
// against a zod schema; a reply that doesn't fit counts as an error, never as a decision.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AiApi } from '../../../shared/aiProviders.js';

export interface AiTarget {
  api: AiApi;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export class AiError extends Error {}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const TIMEOUT_MS = 90_000;

function trimSlash(u: string) {
  return u.replace(/\/+$/, '');
}

/** The first JSON object in a model's reply (some local models wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('The AI did not answer with JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function check<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AiError(`The AI's answer didn't have the expected shape: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

async function errorText(res: { status: number; text(): Promise<string> }): Promise<string> {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (m) return `${m} (${res.status})`;
  } catch {
    /* not JSON */
  }
  return `${t.slice(0, 200) || 'Request failed'} (${res.status})`;
}

export class AiClient {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  /**
   * Ask for a JSON answer that fits `schema`. `system` holds the instructions and rules, `user` the
   * message to judge.
   */
  async askJson<T>(t: AiTarget, req: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<{ data: T; usage: AiUsage }> {
    if (!t.model) throw new AiError('Choose a model for this AI connection');
    switch (t.api) {
      case 'anthropic':
        return this.anthropic(t, req);
      case 'gemini':
        return this.gemini(t, req);
      default:
        return this.openai(t, req);
    }
  }

  private async anthropic<T>(t: AiTarget, req: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }) {
    const client = new Anthropic({ apiKey: t.apiKey, baseURL: trimSlash(t.baseUrl) || undefined, timeout: TIMEOUT_MS, maxRetries: 2 });
    try {
      const res = await client.messages.parse({
        model: t.model,
        max_tokens: req.maxTokens ?? 2048,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: zodOutputFormat(req.schema as z.ZodType<T> & z.ZodObject) },
      });
      if (res.stop_reason === 'refusal') throw new AiError('The AI declined to judge this message');
      if (res.stop_reason === 'max_tokens') throw new AiError('The AI ran out of room for its answer');
      const data = res.parsed_output ?? (() => {
        const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        return check(req.schema, extractJson(text));
      })();
      return { data: check(req.schema, data), usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AiError('The Anthropic API key was not accepted');
      if (err instanceof Anthropic.NotFoundError) throw new AiError(`Anthropic doesn't know the model "${t.model}"`);
      if (err instanceof Anthropic.RateLimitError) throw new AiError('Anthropic rate limit reached; try again later');
      if (err instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic refused the request: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic error ${err.status ?? ''}: ${err.message}`);
      throw new AiError(`Could not reach Anthropic: ${(err as Error).message}`);
    }
  }

  private async post(url: string, headers: Record<string, string>, body: unknown) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (err) {
      throw new AiError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** OpenAI-style chat API: structured JSON where the server supports it, plain JSON instructions otherwise. */
  private async openai<T>(t: AiTarget, req: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }) {
    const url = `${trimSlash(t.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {};
    const schema = z.toJSONSchema(req.schema);
    const messages = [
      { role: 'system', content: `${req.system}\n\nAnswer with one JSON object that fits this JSON Schema, and nothing else:\n${JSON.stringify(schema)}` },
      { role: 'user', content: req.user },
    ];
    // Strict structured output first; servers that don't know it get JSON mode, then plain text.
    const formats: unknown[] = [{ type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } }, { type: 'json_object' }, undefined];
    let lastError = '';
    for (const format of formats) {
      const res = await this.post(url, headers, { model: t.model, messages, temperature: 0, ...(format ? { response_format: format } : {}) });
      if (res.status === 401 || res.status === 403) throw new AiError(`The API key was not accepted: ${await errorText(res)}`);
      if (res.status === 404) throw new AiError(`Not found: check the server address and the model "${t.model}". ${await errorText(res)}`);
      if (res.status === 429) throw new AiError(`Rate limit reached: ${await errorText(res)}`);
      if (!res.ok) {
        lastError = await errorText(res);
        if (res.status === 400 || res.status === 422) continue; // try a simpler format
        throw new AiError(lastError);
      }
      const j = (await res.json()) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const msg = j.choices?.[0]?.message;
      if (msg?.refusal) throw new AiError('The AI declined to judge this message');
      const data = check(req.schema, extractJson(msg?.content ?? ''));
      return { data, usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 } };
    }
    throw new AiError(lastError || 'The AI service refused the request');
  }

  private async gemini<T>(t: AiTarget, req: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number }) {
    const model = t.model.replace(/^models\//, '');
    const url = `${trimSlash(t.baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const schema = z.toJSONSchema(req.schema);
    const res = await this.post(url, { 'x-goog-api-key': t.apiKey }, {
      systemInstruction: { parts: [{ text: `${req.system}\n\nAnswer with one JSON object that fits this JSON Schema:\n${JSON.stringify(schema)}` }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: req.maxTokens ?? 2048 },
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new AiError(`Google refused the request: ${await errorText(res)}`);
    if (res.status === 404) throw new AiError(`Google doesn't know the model "${model}"`);
    if (!res.ok) throw new AiError(`Google error: ${await errorText(res)}`);
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const c = j.candidates?.[0];
    if (!c || c.finishReason === 'SAFETY') throw new AiError('The AI declined to judge this message');
    const text = (c.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return { data: check(req.schema, extractJson(text)), usage: { inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 } };
  }

  /** Model names the service offers ("Load models" in the connection form). */
  async listModels(t: AiTarget): Promise<string[]> {
    const get = async (url: string, headers: Record<string, string>) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const res = await this.fetchImpl(url, { method: 'GET', headers, signal: ctl.signal });
        if (!res.ok) throw new AiError(await errorText(res));
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof AiError) throw err;
        throw new AiError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    };
    if (t.api === 'anthropic') {
      const client = new Anthropic({ apiKey: t.apiKey, baseURL: trimSlash(t.baseUrl) || undefined, timeout: 20_000 });
      try {
        const ids: string[] = [];
        for await (const m of client.models.list()) ids.push(m.id);
        return ids;
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new AiError('The Anthropic API key was not accepted');
        throw new AiError(`Could not list Anthropic models: ${(err as Error).message}`);
      }
    }
    if (t.api === 'gemini') {
      const j = await get(`${trimSlash(t.baseUrl)}/v1beta/models?pageSize=1000`, { 'x-goog-api-key': t.apiKey });
      const models = (j.models as { name: string; supportedGenerationMethods?: string[] }[] | undefined) ?? [];
      return models.filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true).map((m) => m.name.replace(/^models\//, ''));
    }
    const j = await get(`${trimSlash(t.baseUrl)}/models`, t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {});
    return ((j.data as { id: string }[] | undefined) ?? []).map((m) => m.id).sort();
  }
}
