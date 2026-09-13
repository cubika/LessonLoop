export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ModelUsage { requests: number; promptTokens: number; completionTokens: number; milliseconds: number }
export class ModelClient {
  readonly usage: ModelUsage = { requests: 0, promptTokens: 0, completionTokens: 0, milliseconds: 0 };
  constructor(readonly baseUrl: string, readonly model: string, private readonly apiKey: string | undefined) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid model endpoint");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Non-local model endpoints require HTTPS");
  }
  async complete(messages: ChatMessage[]): Promise<string> {
    const start = performance.now();
    this.usage.requests++;
    try {
      const endpoint = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
      const response = await fetch(endpoint + "/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(60000),
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.model, messages, temperature: 0, max_tokens: 1800 }),
      });
      if (!response.ok) throw new Error(`Model endpoint returned HTTP ${response.status}`);
      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      this.usage.promptTokens += result.usage?.prompt_tokens ?? 0;
      this.usage.completionTokens += result.usage?.completion_tokens ?? 0;
      const text = result.choices?.[0]?.message?.content;
      if (!text) throw new Error("Model returned no text");
      return text;
    } finally { this.usage.milliseconds += performance.now() - start; }
  }
}
export function parseJsonResponse(text: string): unknown {
  let clean = text.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  else if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.trimEnd().endsWith("```")) clean = clean.trimEnd().slice(0, -3);
  return JSON.parse(clean.trim());
}
