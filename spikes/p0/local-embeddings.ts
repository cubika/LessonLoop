import http from "node:http";
import { pipeline, env } from "@huggingface/transformers";
import { workspacePath } from "./paths.js";

export interface LocalEmbeddings {
  url: string;
  calls: { embeddings: number; texts: number; unexpectedLlm: number };
  close(): Promise<void>;
}

export async function startLocalEmbeddings(): Promise<LocalEmbeddings> {
  env.allowRemoteModels = false;
  env.cacheDir = workspacePath(".p0", "model-cache");
  const model = await pipeline("feature-extraction", workspacePath(".p0", "models", "all-MiniLM-L6-v2"), {
    device: "cpu", dtype: "q8",
  });
  const calls = { embeddings: 0, texts: 0, unexpectedLlm: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        calls.unexpectedLlm++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No extraction model configured for this storage-only probe" } }));
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Embedding input too large");
      }
      const parsed = JSON.parse(body) as { input?: unknown };
      const texts = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      if (!texts.length || texts.some(text => typeof text !== "string" || text.length > 24000)) throw new Error("Invalid text input");
      calls.embeddings++;
      calls.texts += texts.length;
      const tensor = await model(texts as string[], { pooling: "mean", normalize: true });
      const vectors = tensor.tolist() as number[][];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", model: "all-MiniLM-L6-v2-q8", data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })), usage: { prompt_tokens: 0, total_tokens: 0 } }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Embedding failed" } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No embedding server address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await model.dispose();
    },
  };
}
