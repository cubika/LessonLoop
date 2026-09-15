import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ModelClient, type ChatMessage } from "./model-client.js";

export class CopilotModelClient extends ModelClient {
  unknownUsageCalls = 0;
  constructor(
    readonly python: string,
    model: string,
  ) {
    super("http://127.0.0.1/unused", model, undefined);
  }
  private async invoke(input: unknown) {
    return new Promise<{
      text?: string;
      available?: boolean;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>((resolve, reject) => {
      const child = execFile(
        this.python,
        [
          "-X",
          "utf8",
          fileURLToPath(new URL("./copilot-complete.py", import.meta.url)),
        ],
        {
          windowsHide: true,
          timeout: 150000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        },
        (error, stdout) => {
          try {
            const result = JSON.parse(stdout) as {
              error?: string;
              errorType?: string;
              message?: string;
              text?: string;
              available?: boolean;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (error || result.error)
              reject(
                new Error(
                  [
                    result.error ?? "copilot_provider_failed",
                    result.errorType,
                    result.message,
                  ]
                    .filter(Boolean)
                    .join(": "),
                ),
              );
            else resolve(result);
          } catch {
            reject(
              new Error(
                "copilot_provider_unavailable:" +
                  (error?.killed
                    ? "process_timeout"
                    : (error?.code ?? "invalid_json_response")),
              ),
            );
          }
        },
      );
      child.stdin?.end(JSON.stringify(input));
    });
  }
  async validate() {
    return this.invoke({ validate: true });
  }
  override async complete(messages: ChatMessage[]) {
    this.usage.requests++;
    const start = performance.now();
    try {
      const result = await this.invoke({ model: this.model, messages });
      if (
        !result.usage ||
        result.usage.input_tokens === undefined ||
        result.usage.output_tokens === undefined
      )
        this.unknownUsageCalls++;
      this.usage.promptTokens += result.usage?.input_tokens ?? 0;
      this.usage.completionTokens += result.usage?.output_tokens ?? 0;
      if (!result.text) throw new Error("copilot_provider_empty_response");
      return result.text;
    } catch (error) {
      this.unknownUsageCalls++;
      throw error;
    } finally {
      this.usage.milliseconds += performance.now() - start;
    }
  }
}
