/** Provider-agnostic structured-JSON AI call. Server-side only: the API key never reaches the browser. */

export interface AiConfig { provider: 'anthropic' | 'openai'; apiKey: string; model: string; baseUrl: string }

export class AiError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status = 502, retryable = false) { super(message); this.status = status; this.retryable = retryable; }
}

/** Reads the provider settings from server environment variables. Returns null when no key is configured. */
export function aiConfig(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const provider = (env.JSA_AI_PROVIDER ?? 'anthropic').toLowerCase() === 'openai' ? 'openai' : 'anthropic';
  const apiKey = env.JSA_AI_API_KEY ?? (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!apiKey) return null;
  return {
    provider, apiKey,
    model: env.JSA_AI_MODEL ?? (provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4.1'),
    baseUrl: (env.JSA_AI_BASE_URL ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
  };
}

export interface JsonCall { system: string; user: string; name: string; description: string; schema: Record<string, unknown>; maxTokens?: number; signal?: AbortSignal }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new AiError('The AI returned a response that could not be read. Please try again.', 502, true);
}

async function once(cfg: AiConfig, c: JsonCall): Promise<unknown> {
  let res: Response;
  try {
    if (cfg.provider === 'anthropic') {
      res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST', signal: c.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model, max_tokens: c.maxTokens ?? 6000, system: c.system,
          messages: [{ role: 'user', content: c.user }],
          tools: [{ name: c.name, description: c.description, input_schema: c.schema }],
          tool_choice: { type: 'tool', name: c.name },
        }),
      });
    } else {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST', signal: c.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model, max_tokens: c.maxTokens ?? 6000, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${c.system}\n\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(c.schema)}` },
            { role: 'user', content: c.user },
          ],
        }),
      });
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new AiError('The request was cancelled.', 499);
    throw new AiError('Could not reach the AI provider. Check the server\'s network connection.', 502, true);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (res.status === 401 || res.status === 403) throw new AiError('The AI provider rejected the API key. Check JSA_AI_API_KEY on the server.', 502);
    if (res.status === 404) throw new AiError(`The AI model "${cfg.model}" was not found. Check JSA_AI_MODEL on the server.`, 502);
    if (res.status === 429) throw new AiError('The AI provider is rate-limiting requests. Please wait a moment and retry.', 429, true);
    throw new AiError(`The AI provider returned an error (${res.status}).${detail ? ' ' + detail.slice(0, 200) : ''}`, 502, retryable);
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw new AiError('The AI provider returned an empty response.', 502, true);

  if (cfg.provider === 'anthropic') {
    const blocks = (body.content as { type: string; input?: unknown; text?: string }[] | undefined) ?? [];
    const tool = blocks.find((b) => b.type === 'tool_use');
    if (tool?.input && typeof tool.input === 'object') return tool.input;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) return extractJson(text);
    if (body.stop_reason === 'max_tokens') throw new AiError('The AI response was cut off. Try a smaller number of controls.', 502, false);
    throw new AiError('The AI returned no content.', 502, true);
  }
  const choice = (body.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  if (choice?.finish_reason === 'length') throw new AiError('The AI response was cut off. Try a smaller number of controls.', 502, false);
  return extractJson(choice?.message?.content ?? '');
}

/** Calls the model with retries (rate limits, 5xx, network, unreadable JSON). Backoff: 1.2 s, then 3 s. */
export async function callJson(cfg: AiConfig, c: JsonCall, validate?: (raw: unknown) => void): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await once(cfg, c);
      validate?.(out);
      return out;
    } catch (e) {
      last = e;
      if (e instanceof AiError && !e.retryable) throw e;
      if (attempt < 2) await sleep(attempt === 0 ? 1200 : 3000);
    }
  }
  throw last instanceof AiError ? last : new AiError('The AI request failed. Please try again.');
}

/* ---------------------------------------------------------------- schemas */
export const CONTROLS_SCHEMA = {
  type: 'object',
  properties: {
    controls: { type: 'array', items: { type: 'string' }, description: 'Distinct, detailed control measures. No numbering.' },
    flags: { type: 'array', items: { type: 'string' }, description: 'Uncertainties, missing site information or conflicting instructions for the administrator.' },
  },
  required: ['controls', 'flags'],
};
export const REFINE_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
export const STRUCTURE_SCHEMA = {
  type: 'object',
  properties: {
    activities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, equipment: { type: 'string' },
          hazards: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, controls: { type: 'array', items: { type: 'string' } } }, required: ['name', 'controls'] } },
        },
        required: ['title', 'hazards'],
      },
    },
  },
  required: ['activities'],
};
