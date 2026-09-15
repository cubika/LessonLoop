import test from "node:test";
import assert from "node:assert/strict";
import type { HindsightEngine } from "../src/adapters/hindsight/engine.js";
import { advanceNativeModel } from "../src/core/native-model.js";

function fixture() {
  const calls: string[] = [];
  let operationId: string | undefined;
  const engine = {
    async findModelOperation() {
      calls.push("lookup");
      return operationId;
    },
    async createModel() {
      calls.push("submit");
      operationId = "op";
      return { operation_id: operationId, mental_model_id: "model" };
    },
    async cancelModelSubmission() {
      calls.push("close");
      return { submission_canceled: true, operation_id: operationId ?? null };
    },
    async operation(): ReturnType<HindsightEngine["operation"]> {
      calls.push("poll");
      return { operation_id: "op", status: "pending" };
    },
    async model(): Promise<Awaited<ReturnType<HindsightEngine["model"]>>> {
      calls.push("read");
      return {
        reflect_response: {
          structured_output: { accepted: true },
          lessonloop_usage: {
            input_tokens: 2,
            output_tokens: 3,
            complete: true,
          },
        },
      } as any;
    },
  };
  const request = {
    scopeId: "scope",
    modelId: "model",
    query: "Frozen evidence",
    sourceRefs: ["source"],
    schema: { type: "object" },
  };
  const remembered: string[] = [];
  const remember = async (id: string) => {
    calls.push("save");
    remembered.push(id);
  };
  const run = (
    overrides: Partial<Parameters<typeof advanceNativeModel>[1]> = {},
    save = remember,
  ) => advanceNativeModel(engine, { ...request, ...overrides }, save);
  return { engine, request, calls, remembered, run };
}

test("A lost operation-ID write recovers the accepted submission before polling", async () => {
  const f = fixture();
  await assert.rejects(
    f.run({}, async () => {
      throw new Error("storage unavailable");
    }),
    /storage unavailable/,
  );
  assert.deepEqual(await f.run(), {
    status: "waiting",
  });
  assert.deepEqual(f.calls, ["lookup", "submit", "lookup", "save", "poll"]);
  assert.deepEqual(f.remembered, ["op"]);
});

test("A lost native reply recovers the operation without submitting again", async () => {
  const f = fixture();
  const submit = f.engine.createModel;
  f.engine.createModel = async () => {
    await submit();
    throw new Error("reply lost");
  };
  await assert.rejects(f.run(), /reply lost/);
  await f.run();
  assert.equal(f.calls.filter((call) => call === "submit").length, 1);
  assert.deepEqual(f.remembered, ["op"]);
});

for (const status of [
  "pending",
  "processing",
  "failed",
  "cancelled",
  "not_found",
  "completed",
] as const) {
  test(
    "Native status " + status + " is handled before any result read",
    async () => {
      const f = fixture();
      f.engine.operation = async () => {
        f.calls.push("poll");
        return { operation_id: "op", status };
      };
      const run = () => f.run({ operationId: "op" });
      if (status === "not_found")
        await assert.rejects(run(), /native_operation_unconfirmed/);
      else {
        const result = await run();
        assert.equal(
          result.status,
          status === "completed"
            ? "completed"
            : ["failed", "cancelled"].includes(status)
              ? "failed"
              : "waiting",
        );
        if (result.status === "completed") {
          assert.deepEqual(result.output, { accepted: true });
          assert.deepEqual(result.usage, {
            input_tokens: 2,
            output_tokens: 3,
            complete: true,
          });
        }
      }
      assert.deepEqual(
        f.calls,
        status === "completed" ? ["poll", "read"] : ["poll"],
      );
    },
  );
}

test("Transient lookup and result failures propagate without creating a replacement", async () => {
  const f = fixture();
  f.engine.findModelOperation = async () => {
    throw new Error("lookup timeout");
  };
  await assert.rejects(f.run(), /lookup timeout/);
  f.engine.operation = async () => ({
    operation_id: "op",
    status: "completed",
  });
  f.engine.model = async () => {
    throw new Error("read timeout");
  };
  await assert.rejects(f.run({ operationId: "op" }), /read timeout/);
  assert.deepEqual(f.calls, []);
});

test("Legacy missing requests fail only after the native submission is closed", async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ query: undefined }), {
    status: "failed",
    reason: "native_request_unavailable",
  });
  assert.deepEqual(f.calls, ["lookup", "close"]);
});

test("Closing a legacy submission recovers a concurrently accepted operation", async () => {
  const f = fixture();
  f.engine.cancelModelSubmission = async () => ({
    submission_canceled: true,
    operation_id: "late-op",
  });
  assert.deepEqual(await f.run({ query: undefined }), { status: "waiting" });
  assert.deepEqual(f.remembered, ["late-op"]);
  assert.deepEqual(f.calls, ["lookup", "save", "poll"]);
});

test("An unconfirmed legacy submission closure remains retryable", async () => {
  const f = fixture();
  f.engine.cancelModelSubmission = async () => {
    throw new Error("close timeout");
  };
  await assert.rejects(f.run({ query: undefined }), /close timeout/);
  assert.deepEqual(f.remembered, []);
});

test("Frozen prompts are rebuilt only when an operation needs submission", async () => {
  const f = fixture();
  let builds = 0;
  const query = () => {
    builds++;
    return f.request.query;
  };
  await f.run({ query });
  assert.equal(builds, 1);
  await f.run({
    query: () => {
      throw new Error("must not rebuild while recovering");
    },
  });
  await f.run({
    operationId: "op",
    query: () => {
      throw new Error("must not rebuild while polling");
    },
  });
  assert.equal(f.calls.filter((call) => call === "submit").length, 1);
});
