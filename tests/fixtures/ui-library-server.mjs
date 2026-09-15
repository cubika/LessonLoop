import { createServer } from "node:http";
export async function startUiFixture() {
  const createdAt = new Date().toISOString();
  const experience = {
    id: "experience-ui",
    revision: 2,
    scopeId: "ui-check",
    conclusion: "重新生成后核对字段与扩展",
    level: "L1",
    assessment: "supported",
    state: "held",
    conditions: [{ text: "使用版本 2" }],
    exceptions: [],
    topics: ["生成文件"],
    createdAt,
    updatedAt: createdAt,
    evidence: [{ role: "tool", excerpt: "输出包含 auditTag 扩展。" }],
    review: { question: "核对最新版本是否仍保留扩展", reviewBy: createdAt },
  };
  const base = {
    id: "method-ui",
    revision: 2,
    scopeId: "ui-check",
    title: "核对生成文件",
    goal: "修改字段后保留已有扩展",
    state: "active",
    topics: ["生成文件"],
    conditions: [],
    exceptions: [],
    applicability: "general",
    steps: [
      { stepId: "s1", instruction: "读取当前文件", supportIndexes: [0] },
      { stepId: "s2", instruction: "核对生成输出", supportIndexes: [0] },
    ],
    completionChecks: [{ text: "字段符合预期" }],
    stopConditions: [],
    supportRefs: [{ kind: "experience", id: experience.id, revision: 2 }],
    change: {
      kind: "create",
      summary: "用于界面检查的独立样例",
      caseRefs: [],
      predecessors: [],
    },
    createdAt,
    updatedAt: createdAt,
    pinned: false,
  };
  const methods = Array.from({ length: 14 }, (_, i) => ({
    ...structuredClone(base),
    id: i ? "method-ui-" + i : base.id,
    title: base.title + (i ? " " + i : ""),
  }));
  const workCase = {
    id: "case-ui",
    revision: 1,
    scopeId: "ui-check",
    topic: "生成文件中的字段恢复",
    goal: "保留字段",
    context: { version: "2" },
    attempts: [
      {
        stepId: "s1",
        action: "重新生成",
        observation: "扩展仍存在",
        outcome: "succeeded",
      },
    ],
    result: { status: "succeeded", summary: "已读回核对" },
    unresolved: ["不同版本待测"],
    coverage: ["单个本地 fixture"],
    methodUses: [
      {
        taskRef: "task-ui",
        methodUseRef: "use-ui",
        method: { id: base.id, revision: 2 },
      },
    ],
    evidence: experience.evidence,
    createdAt,
    updatedAt: createdAt,
    taskRef: "task-ui",
  };

  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { operation, input = {} } = JSON.parse(raw);
      let result;
      switch (operation) {
        case "settings.get":
          result = [
            {
              id: "ui-check",
              scopeId: "ui-check",
              revision: 1,
              learning: true,
              recommendation: true,
              review: true,
              notifications: false,
            },
          ];
          break;
        case "browseMethods": {
          const rows = methods.filter(
            (m) =>
              (!input.pinnedOnly || m.pinned) &&
              (!input.query || m.title.includes(input.query)) &&
              (!input.topic || m.topics.includes(input.topic)) &&
              (!input.state || m.state === input.state),
          );
          const offset = Number(input.cursor || 0),
            items = rows.slice(offset, offset + (input.limit || 20));
          result = {
            items,
            total: rows.length,
            ...(offset + items.length < rows.length
              ? { nextCursor: String(offset + items.length) }
              : {}),
          };
          break;
        }
        case "pinMethod":
          methods.find((m) => m.id === input.id).pinned = input.pinned;
          result = { pinned: input.pinned };
          break;
        case "inspectMethod":
          result = methods.find((m) => m.id === input.id);
          break;
        case "methodHistory":
          result = [{ ...base, revision: 1, title: "旧版生成文件检查" }];
          break;
        case "inspect":
          result = experience;
          break;
        case "browse":
          result = [experience];
          break;
        case "browseWorkCases":
          result = [workCase];
          break;
        case "inspectWorkCase":
          result = workCase;
          break;
        case "listTasks":
          result = [
            {
              taskRef: "task-ui",
              scopeId: "ui-check",
              callerId: "copilot-host",
              ended: false,
              createdAt,
            },
          ];
          break;
        case "prepareMethod":
          result = {
            status: "guidance",
            methodUseRef: "use-ui",
            steps: base.steps,
            completionChecks: base.completionChecks,
          };
          break;
        case "submitMaterial":
          result = { accepted: true, jobId: "job-ui" };
          break;
        case "getJob":
          result = { id: "job-ui", status: "completed", results: [] };
          break;
        case "reviseMethod":
          result = { accepted: true, reviewId: "review-ui" };
          break;
        case "getRevisionReview":
          result = { status: "completed" };
          break;
        case "feedback":
        case "rateMethodUse":
          result = { accepted: true, results: [{ status: "accepted" }] };
          break;
        case "reviews.notifications":
          result = [];
          break;
        default:
          throw new Error("Unexpected UI RPC: " + operation);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
