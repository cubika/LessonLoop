import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import type { Method } from "../src/domain/schema.js";
const secret = JSON.parse(
  await readFile(".local-validation/data/development-secret.json", "utf8"),
);
const previous = JSON.parse(
  await readFile(".local-validation/results/p0-method-path.json", "utf8"),
);
const store = new ProductStore(
  `postgresql://lessonloop:${encodeURIComponent(secret.password)}@127.0.0.1:19432/postgres`,
);
await store.open();
const core = new CoreService(
  store,
  new HindsightEngine("http://127.0.0.1:19888", secret.engineToken),
);
const host = {
  id: randomUUID(),
  channel: "host" as const,
  scopes: [previous.scope],
};
const agent = {
  id: randomUUID(),
  channel: "agent" as const,
  taskOwnerId: host.id,
  scopes: host.scopes,
};
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
try {
  const method = (await core.inspect(
    host,
    "method",
    previous.methods[0].id,
  )) as Method;
  const task = await core.startTask(host, previous.scope);
  const lead = await core.prepare(host, {
    methodId: method.id,
    revision: method.revision,
    taskRef: task.taskRef,
  });
  report.lead = lead;
  const raw =
    "This current task uses the fixture pipeline that copies schema.json to client.json. The requested generated client contract field must survive regeneration. The pipeline relationship is confirmed by reading the pipeline configuration.";
  await core.recordHostObservation(host, {
    taskRef: task.taskRef,
    eventId: "pipeline-read",
    text: raw,
    occurredAt: new Date().toISOString(),
  });
  report.assessment = await core.reassessTask(agent, {
    taskRef: task.taskRef,
    methodId: method.id,
    revision: method.revision,
    methodUseRef: lead.methodUseRef,
  });
  report.prepared = await core.prepare(agent, {
    methodId: method.id,
    revision: method.revision,
    taskRef: task.taskRef,
    methodUseRef: lead.methodUseRef,
  });
  report.status =
    (report.prepared as { status: string }).status === "guidance"
      ? "passed"
      : "failed";
} catch (e) {
  report.status = "failed";
  report.error = e instanceof Error ? e.message : "unknown";
} finally {
  await store.close();
  await writeFile(
    ".local-validation/results/observation-validation.json",
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify({ status: report.status, error: report.error }));

process.exitCode = report.status === "passed" ? 0 : 1;
