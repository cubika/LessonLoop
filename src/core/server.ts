import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ApiError, CoreService, type Principal } from "./service.js";
import { Conflict } from "../store/postgres.js";
import { Effects } from "./effects.js";
import { Reviews } from "./reviews.js";
import { SampleConnector } from "../connectors/sample.js";
import { workView } from "./source-views.js";
import { getGuidance } from "./guidance.js";
const connectors = new WeakMap<CoreService, SampleConnector>();
function sample(core: CoreService) {
  let connector = connectors.get(core);
  if (!connector) {
    connector = new SampleConnector(core, core.store);
    connectors.set(core, connector);
  }
  return connector;
}

export async function tickConnectors(core: CoreService, scopes: string[]) {
  return sample(core).tick(scopes);
}
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
): Promise<unknown> {
  const input = raw ?? {};
  switch (operation) {
    case "getGuidance":
      return getGuidance(core, p, input, key);
    case "submitSource":
      return core.submitSource(p, input, key);
    case "inspectSource":
      return core.inspect(p, "source", identifier.parse(input).id);
    case "getWorkView": {
      const target = z
        .object({
          kind: z.enum(["source", "experience", "playbook"]),
          id: z.string(),
        })
        .strict()
        .parse(input);
      return workView(core, p, target);
    }
    case "connector.add":
      return sample(core).add(p, input);
    case "connector.list":
      return sample(core).list(p);
    case "connector.schedule":
      return sample(core).schedule(p, input);
    case "connector.sync":
      return sample(core).sync(p, identifier.parse(input).id);
    case "connector.bindings":
      return sample(core).bindings(p, identifier.parse(input).id);
    case "connector.state": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          status: z.enum(["active", "paused", "removed"]),
        })
        .strict()
        .parse(input);
      return sample(core).state(p, v.id, v.expectedRevision, v.status);
    }
    case "connector.forget": {
      const v = z
        .object({ id: z.string(), sourceKey: z.string().min(1).max(128) })
        .strict()
        .parse(input);
      return sample(core).forget(p, v.id, v.sourceKey);
    }
    case "reviews.export":
      return new Reviews(core.store).exportCases(p, input);
    case "reviews.issue":
      return new Reviews(core.store).recordIssue(p, input);
    case "reviews.issues":
      return new Reviews(core.store).issues(p);
    case "reviews.list":
      return new Reviews(core.store).list(p);
    case "reviews.configure":
      return new Reviews(core.store).configure(p, input);
    case "reviews.notifications":
      return new Reviews(core.store).notifications(p);
    case "reviews.dismiss":
      return new Reviews(core.store).dismiss(p, identifier.parse(input).id);
    case "updateTaskFeedback":
      return new Effects(core.store).update(p, input);
    case "getTaskFeedback": {
      const { taskRef } = z
        .object({ taskRef: z.string() })
        .strict()
        .parse(input);
      const value = (await new Effects(core.store).cases(p.scopes)).find(
        (c) => c.id === taskRef,
      );
      if (!value) throw new ApiError("feedback_unavailable", 404);
      return value;
    }
    case "listTasks": {
      const v = z
        .object({ scopeId: z.string().optional() })
        .strict()
        .parse(input);
      return core.listTasks(p, v.scopeId);
    }
    case "pinPlaybook":
      return core.pinPlaybook(p, input);
    case "getEffectSummary":
      return new Effects(core.store).summary(p.scopes);
    case "getUsageView": {
      const v = z
        .object({ playbookId: z.string().optional() })
        .strict()
        .parse(input);
      if (v.playbookId) await core.inspect(p, "playbook", v.playbookId);
      return (await new Effects(core.store).cases(p.scopes)).filter(
        (row) =>
          !v.playbookId ||
          row.feedback.some((f) => f.playbookId === v.playbookId),
      );
    }
    case "clearEffectData": {
      if (p.channel !== "user")
        throw new ApiError("user_operation_required", 403);
      const v = z.object({ scopeId: z.string() }).strict().parse(input);
      if (!p.scopes.includes(v.scopeId)) throw new ApiError("not_found", 404);
      return new Effects(core.store).clear(v.scopeId);
    }
    case "settings.get":
      return core.getSettings(p);
    case "settings.update":
      return core.configure(p, input);
    case "listSources":
      return core.listSources(p);
    case "controlSource":
      return core.controlSource(p, input);
    case "getSourceCleanup":
      return core.inspect(p, "source_cleanup", identifier.parse(input).id);
    case "getJob":
      return core.getJob(p, identifier.parse(input).id);
    case "cancelJob":
      await core.cancelJob(p, identifier.parse(input).id);
      return core.getJob(p, identifier.parse(input).id);
    case "retryJob":
      return core.retryJob(p, identifier.parse(input).id, key);
    case "connector.retry":
      return sample(core).retry(p, identifier.parse(input).id, key);
    case "reviewTopic": {
      const v = z
        .object({ scopeId: z.string(), topic: z.string().min(1).max(512) })
        .strict()
        .parse(input);
      return core.reviewTopic(p, v.scopeId, v.topic);
    }
    case "searchPlaybooks": {
      const v = z
        .object({
          query: z.string().min(1).max(2048),
          scopeIds: z.array(z.string()).max(32).optional(),
        })
        .strict()
        .parse(input);
      return core.search(
        {
          ...p,
          scopes: p.scopes.filter((s) => !v.scopeIds || v.scopeIds.includes(s)),
        },
        v.query,
      );
    }
    case "browsePlaybooks": {
      return core.browsePlaybooks(p, input);
    }
    case "inspectPlaybook":
      return core.inspect(p, "playbook", identifier.parse(input).id);
    case "playbookHistory":
      return core.history(p, identifier.parse(input).id);
    case "getRevisionReview":
      return core.inspect(p, "revision_review", identifier.parse(input).id);
    case "exportPlaybook": {
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
    case "reviseExperience": {
      if (p.channel !== "user")
        throw new ApiError("user_operation_required", 403);
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          correctionText: z.string().min(1).max(2048),
        })
        .strict()
        .parse(input);
      return core.feedback(p, {
        target: { kind: "experience", id: v.id, revision: v.expectedRevision },
        rating: "incorrect",
        correctionText: v.correctionText,
      });
    }
    case "inspectExperience":
      return core.inspect(p, "experience", identifier.parse(input).id);
    case "browseExperiences":
      return core.browse(p, "experience");
    case "setExperienceState": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          state: z.enum(["active", "disabled"]),
        })
        .strict()
        .parse(input);
      return core.setState(p, "experience", v.id, v.expectedRevision, v.state);
    }
    case "removeExperience": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(input);
      return core.remove(p, "experience", v.id, v.expectedRevision);
    }
    case "recallExperiences": {
      return core.recallRequest(p, input);
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
    case "recordHostObservation":
      return core.recordHostObservation(p, input);
    case "preparePlaybook":
      return core.prepare(p, input);
    case "setPlaybookState": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
          state: z.enum(["active", "disabled"]),
        })
        .strict()
        .parse(input);
      return core.setState(p, "playbook", v.id, v.expectedRevision, v.state);
    }
    case "revisePlaybook": {
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
    case "removePlaybook": {
      const v = z
        .object({
          id: z.string(),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(input);
      return core.remove(p, "playbook", v.id, v.expectedRevision);
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
