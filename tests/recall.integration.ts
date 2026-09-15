import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProductStore } from "../src/store/postgres.js";
import { CoreService } from "../src/core/service.js";
import { HindsightEngine } from "./fixtures/method-engine.js";
import { identity, digest, type ObjectRef } from "../src/domain/schema.js";
import { experienceSchema } from "../src/domain/experience.js";
const url = process.env.LESSONLOOP_TEST_DATABASE_URL;
if (!url) throw new Error("database required");
class RecallEngine extends HindsightEngine {
  allowed: ObjectRef[] = [];
  target = "";
  beforeReturn?: () => Promise<void>;
  fail = false;
  constructor() {
    super("http://127.0.0.1:19888", "unused");
  }
  override async searchPublished(
    _scope: string,
    _query: string,
    refs: ObjectRef[],
    kind: "playbook" | "experience" = "playbook",
  ) {
    assert.equal(kind, "experience");
    this.allowed = refs;
    if (this.fail) throw new Error("semantic unavailable");
    await this.beforeReturn?.();
    return [
      {
        id: "hit",
        text: "Source schema",
        type: "world",
        metadata: { product_id: this.target },
      },
    ] as any;
  }
}
test("Direct experience recall uses eligible multilingual hits, exact entities and current versions", async () => {
  const store = new ProductStore(url);
  await store.open();
  try {
    const scope = randomUUID(),
      p = { id: randomUUID(), channel: "user" as const, scopes: [scope] },
      engine = new RecallEngine(),
      core = new CoreService(store, engine);
    const add = async (
      text: string,
      entities: string[],
      state: "active" | "disabled" = "active",
    ) => {
      const fp = digest([scope, text]),
        e = experienceSchema.parse({
          ...identity(scope),
          conclusion: text,
          level: "L1",
          purpose: "fact",
          applicability: "general",
          conditions: [],
          exceptions: [],
          topics: [],
          entities,
          basis: "observed",
          assessment: "supported",
          evidence: [
            {
              excerpt: text,
              role: "tool",
              relation: "supports",
              fingerprint: fp,
            },
          ],
          derivedFrom: [],
          sourceFingerprints: [fp],
          state,
        });
      await store.transaction(async (tx) => {
        await tx.put(
          {
            kind: "experience",
            id: e.id,
            scopeId: scope,
            revision: 1,
            value: e,
          },
          null,
        );
        await tx.put(
          {
            kind: "source",
            id: fp,
            scopeId: scope,
            revision: 1,
            value: { id: fp, scopeId: scope, revision: 1, blocked: false },
          },
          null,
        );
        await tx.put(
          {
            kind: "projection",
            id: e.id,
            scopeId: scope,
            revision: 1,
            value: {
              id: e.id,
              scopeId: scope,
              revision: 1,
              objectKind: "experience",
              objectRevision: 1,
              confirmed: true,
              text: e.conclusion,
            },
          },
          null,
        );
      });
      return e;
    };
    const english = await add("Edit the source schema before regeneration", []),
      exact = await add("Known request mismatch", ["ERR_SNAPSHOT_17"]),
      disabled = await add("Unavailable source", [], "disabled");
    engine.target = english.id;
    engine.target = "missing";
    assert.equal(
      (await core.recall(p, "How can I compress a video?")).results.length,
      0,
    );
    engine.target = english.id;
    const chinese = await core.recall(p, "重新生成覆盖修改");
    assert.equal(chinese.results[0]!.experience.id, english.id);
    assert.equal(
      engine.allowed.some((r) => r.id === disabled.id),
      false,
    );
    const precise = await core.recall(p, "ERR_SNAPSHOT_17");
    assert.equal(precise.results[0]!.experience.id, exact.id);
    engine.beforeReturn = async () =>
      store.transaction(async (tx) => {
        const old = await tx.get<any>("experience", english.id);
        await tx.put(
          {
            kind: "experience",
            id: old.id,
            scopeId: scope,
            revision: 2,
            value: {
              ...old,
              revision: 2,
              conclusion: "Unrelated changed topic",
            },
          },
          1,
        );
        const projection = await tx.get<any>("projection", english.id);
        await tx.put(
          {
            kind: "projection",
            id: english.id,
            scopeId: scope,
            revision: 2,
            value: {
              ...projection,
              revision: 2,
              objectRevision: 2,
              confirmed: true,
            },
          },
          1,
        );
      });
    assert.equal(
      (await core.recall(p, "重新生成覆盖修改")).results.some(
        (r) => r.experience.id === english.id,
      ),
      false,
    );
    engine.beforeReturn = () =>
      core.setState(p, "experience", english.id, 2, "disabled").then(() => {});
    assert.equal(
      (await core.recall(p, "重新生成覆盖修改")).results.some(
        (r) => r.experience.id === english.id,
      ),
      false,
    );
    delete engine.beforeReturn;
    engine.fail = true;
    await assert.rejects(
      core.recall(p, "ERR_SNAPSHOT_17"),
      /semantic unavailable/,
    );
  } finally {
    await store.close();
  }
});
