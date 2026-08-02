import { requestUrl } from "obsidian";

export type ProviderId = "ollama" | "openai" | "anthropic";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatRequest {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
}

/**
 * All providers go through Obsidian's requestUrl, which bypasses CORS.
 * Non-streaming by design: requestUrl doesn't stream, and the preview-modal
 * UX shows the full result anyway.
 */
export async function chat(
  provider: ProviderId,
  cfg: ProviderConfig,
  req: ChatRequest
): Promise<string> {
  switch (provider) {
    case "ollama":
      return chatOllama(cfg, req);
    case "openai":
      return chatOpenAI(cfg, req);
    case "anthropic":
      return chatAnthropic(cfg, req);
  }
}

async function chatOllama(cfg: ProviderConfig, req: ChatRequest): Promise<string> {
  const base = (cfg.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const res = await requestUrl({
    url: `${base}/api/chat`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
    throw: false,
  });
  if (res.status >= 400) throw providerError("Ollama", res.status, res.text);
  return res.json?.message?.content ?? "";
}

async function chatOpenAI(cfg: ProviderConfig, req: ChatRequest): Promise<string> {
  const base = (cfg.baseUrl || "https://api.openai.com").replace(/\/$/, "");
  const res = await requestUrl({
    url: `${base}/v1/chat/completions`,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: req.temperature,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
    throw: false,
  });
  if (res.status >= 400) throw providerError("OpenAI", res.status, res.text);
  return res.json?.choices?.[0]?.message?.content ?? "";
}

async function chatAnthropic(cfg: ProviderConfig, req: ChatRequest): Promise<string> {
  const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const res = await requestUrl({
    url: `${base}/v1/messages`,
    method: "POST",
    contentType: "application/json",
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }),
    throw: false,
  });
  if (res.status >= 400) throw providerError("Anthropic", res.status, res.text);
  const blocks = res.json?.content ?? [];
  return blocks
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");
}

function providerError(name: string, status: number, body: string): Error {
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.error ?? body;
  } catch {
    /* raw body */
  }
  return new Error(`${name} ${status}: ${String(detail).slice(0, 300)}`);
}
