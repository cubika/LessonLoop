import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ApiError, CoreService, type Principal } from "./service.js";
import { Conflict } from "../store/postgres.js";

export interface Credential {
  token: string;
  principal: Principal;
}
const envelope = z
  .object({ operation: z.string(), input: z.unknown().optional() })
  .strict();
const identifier = z.object({ id: z.string().min(1).max(128) }).strict();
export async function dispatch(
  core: CoreService,
  p: Principal,
  operation: string,
  raw: unknown,
  key: string,
) {
  const input = raw ?? {};
  switch (operation) {
    case "settings.get":
      return core.getSettings(p);
    case "settings.update":
      return core.configure(p, input);
    case "submitMaterial":
      return core.submitMaterial(p, input, key);
    case "getJob":
      return core.getJob(p, identifier.parse(input).id);
    case "cancelJob":
      return core.cancelJob(p, identifier.parse(input).id);
    case "reviewTopic": {
      const v = z
        .object({ scopeId: z.string(), topic: z.string().min(1).max(512) })
        .strict()
        .parse(input);
      return core.reviewTopic(p, v.scopeId, v.topic);
    }
    case "searchMethods": {
      const v = z
        .object({ query: z.string().min(1).max(2048) })
        .strict()
        .parse(input);
      return core.search(p, v.query);
    }
    case "browseMethods": {
      const v = z
        .object({
          query: z.string().max(2048).optional(),
          state: z.enum(["active", "held", "disabled"]).optional(),
        })
        .strict()
        .parse(input);
      return core.browse(p, "method", v.query, v.state);
    }
    case "inspectMethod":
      return core.inspect(p, "method", identifier.parse(input).id);
    case "methodHistory":
      return core.history(p, identifier.parse(input).id);
    case "getRevisionReview":
      return core.inspect(p, "revision_review", identifier.parse(input).id);
    case "exportMethod": {
      const v = z
        .object({
          id: z.string(),
          revision: z.number().int().positive(),
          format: z.enum(["markdown", "checklist", "skill"]),
          includeEvidence: z.boolean().optional(),
        })
        .strict()
        .parse(input);
      return core.export(p, v.id, v.revision, v.format, v.includeEvidence);
    }
    case "feedback":
      return core.feedback(p, input);
    case "inspectWorkCase":
      return core.inspect(p, "work_case", identifier.parse(input).id);
    case "browseWorkCases":
      return core.browse(p, "work_case");
    case "inspect":
      return core.inspect(p, "experience", identifier.parse(input).id);
    case "browse":
      return core.browse(p, "experience");
    case "recall": {
      const v = z
        .object({ query: z.string().min(1).max(2048) })
        .strict()
        .parse(input);
      return core.recall(p, v.query);
    }
    case "startTask": {
      const v = z
        .object({
          scopeId: z.string().min(1).max(128),
          eventId: z.string().min(1).max(128).optional(),
        })
        .strict()
        .parse(input);
      return core.startTask(p, v.scopeId, v.eventId);
    }
    case "observeTask":
      return core.observe(p, input);
    case "prepareMethod":
      return core.prepare(p, input);
    case "setMethodState": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          state: z.enum(["active", "disabled"]),
        })
        .strict()
        .parse(input);
      return core.setState(p, "method", v.id, v.expectedRevision, v.state);
    }
    case "reviseMethod": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          body: z.unknown(),
        })
        .strict()
        .parse(input);
      return core.revise(p, v.id, v.expectedRevision, v.body);
    }
    case "removeMethod": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(input);
      return core.remove(p, "method", v.id, v.expectedRevision);
    }
    default:
      throw new ApiError("unknown_operation", 404);
  }
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > 262144) throw new ApiError("request_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function apiServer(core: CoreService, credentials: Credential[]) {
  if (
    !credentials.length ||
    credentials.some((c) => Buffer.byteLength(c.token) < 32)
  )
    throw new Error("strong_api_credentials_required");
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    );
    try {
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host))
        throw new ApiError("invalid_host", 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw new ApiError("invalid_origin", 403);
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(req.url ?? "")
      ) {
        const file = req.url === "/" ? "index.html" : req.url!.slice(1);
        const content = await readFile(
          fileURLToPath(new URL(`../ui/${file}`, import.meta.url)),
        );
        res.setHeader(
          "Content-Type",
          file.endsWith("html")
            ? "text/html; charset=utf-8"
            : file.endsWith("js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        );
        res.end(content);
        return;
      }
      const provided = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : "";
      const credential = credentials.find(
        (c) =>
          Buffer.byteLength(c.token) === Buffer.byteLength(provided) &&
          timingSafeEqual(Buffer.from(c.token), Buffer.from(provided)),
      );
      if (!credential) throw new ApiError("authentication_required", 401);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (req.method === "GET" && req.url === "/v1/status") {
        const engine = await core.engine
          .health()
          .then((v) => ({ status: "ready", version: v }))
          .catch(() => ({ status: "unavailable" }));
        res.end(
          JSON.stringify({
            apiVersion: 1,
            core: "ready",
            engine,
            settings: await core.getSettings(credential.principal),
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/rpc")
        throw new ApiError("not_found", 404);
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new ApiError("json_required", 415);
      const v = envelope.parse(await body(req));
      const result = await dispatch(
        core,
        credential.principal,
        v.operation,
        v.input,
        String(req.headers["idempotency-key"] ?? ""),
      );
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.statusCode =
        e instanceof ApiError
          ? e.httpStatus
          : e instanceof Conflict
            ? 409
            : e instanceof z.ZodError || e instanceof SyntaxError
              ? 400
              : 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error:
            e instanceof ApiError
              ? e.code
              : e instanceof Conflict
                ? e.message
                : e instanceof z.ZodError
                  ? "invalid_input"
                  : e instanceof SyntaxError
                    ? "invalid_json"
                    : "service_unavailable",
        }),
      );
    }
  });
}
