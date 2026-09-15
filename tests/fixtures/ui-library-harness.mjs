import vm from "node:vm";
import { webcrypto as crypto } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startUiFixture } from "./ui-library-server.mjs";
// Minimal DOM surface for the shipped event handlers. Layout is outside this test.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this._text = "";
    this._value = undefined;
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set value(value) {
    this._value = value ?? "";
  }
  get value() {
    return (
      this._value ??
      (this.tag === "select"
        ? (this.children.find((c) => c.selected)?.value ??
          this.children[0]?.value ??
          "")
        : "")
    );
  }
  get firstChild() {
    return this.children[0];
  }
  get options() {
    return this.children;
  }
  get selectedOptions() {
    return this.children.filter((c) => c.selected);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(...children) {
    for (const child of children) child.parent = this;
    this.children.unshift(...children);
  }
  replaceChildren(...children) {
    this._text = "";
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  remove() {
    this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  querySelector(selector) {
    return walk(this).find(
      (c) => selector === "[data-reload]" && c.dataset.reload,
    );
  }
  click() {
    return this.onclick?.({
      target: this,
      stopPropagation() {},
      preventDefault() {},
    });
  }
  select() {}
}
function walk(element) {
  return element.children.flatMap((c) => [c, ...walk(c)]);
}
export async function runUiLibraryChecks() {
  const fixture = await startUiFixture();
  try {
    const html = await readFile(
        new URL("../../src/ui/index.html", import.meta.url),
        "utf8",
      ),
      elements = new Map();
    for (const match of html.matchAll(/<([a-z]+)[^>]* id="([^"]+)"/g))
      elements.set(match[2], new Element(match[1]));
    for (const match of html.matchAll(
      /<select id="([^"]+)">([\s\S]*?)<\/select>/g,
    ))
      for (const option of match[2].matchAll(
        /<option value="([^"]*)">([^<]*)<\/option>/g,
      )) {
        const element = new Element("option");
        element.value = option[1];
        element.textContent = option[2];
        elements.get(match[1]).append(element);
      }
    const nav = [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => {
      const e = new Element("button");
      e.dataset.view = match[1];
      return e;
    });
    const requests = [];
    const context = vm.createContext({
      document: {
        getElementById: (id) => elements.get(id),
        createElement: (tag) => new Element(tag),
        querySelectorAll: () => nav,
      },
      fetch: async (path, options) => {
        if (options?.body) requests.push(JSON.parse(options.body));
        return fetch(new URL(path, fixture.baseUrl), options);
      },
      crypto,
      structuredClone,
      Blob,
      URL,
      setTimeout,
      setInterval: () => 0,
      confirm: () => true,
      console,
    });
    vm.runInContext(
      await readFile(new URL("../../src/ui/app.js", import.meta.url), "utf8"),
      context,
    );
    const run = (code) => vm.runInContext(code, context),
      $ = (id) => elements.get(id),
      button = (root, text) => {
        const value = walk(root).find(
          (e) => e.tag === "button" && e._text === text,
        );
        assert.ok(value, "button " + text);
        return value;
      },
      field = (root, label) => {
        const value = walk(root)
          .find((e) => e.tag === "label" && e._text === label)
          ?.children.find((e) =>
            ["input", "textarea", "select"].includes(e.tag),
          );
        assert.ok(value, "field " + label);
        return value;
      };
    async function input(root, label, value) {
      const f = field(root, label);
      f.value = value;
      await f.oninput?.();
      await f.onchange?.();
      return f;
    }
    async function click(root, text) {
      await button(root, text).click();
      assert.equal($("notice").textContent, "", "UI error");
    }
    const checks = [];
    $("token").value = "fixture";
    await $("connect").click();
    assert.equal($("cards").children.length, 12);
    await click($("playbook-pages"), "下一页");
    assert.equal($("cards").children.length, 2);
    checks.push("playbook pagination");
    await click($("cards"), "设为常用");
    assert.equal(requests.at(-2).operation, "pinPlaybook");
    assert.ok($("playbook-pages").textContent.includes("第 1 页"));
    checks.push("pin resets pagination");
    $("playbook-topic").value = "生成文件";
    $("playbook-state").value = "active";
    await $("search").onsubmit({ preventDefault() {} });
    assert.equal(
      requests.findLast((r) => r.operation === "browsePlaybooks").input.topic,
      "生成文件",
    );
    checks.push("filter request");
    await run("show('playbook-ui')");
    await click($("detail"), "查看依据");
    assert.doesNotMatch($("detail").textContent, /undefined|L[1-5]/);
    await click($("detail"), "修改方法");
    let editor = $("detail").children.find((e) =>
      e.textContent.includes("修改说明"),
    );
    assert.ok(editor);
    await click(editor, "添加步骤");
    let steps = walk(editor).filter((e) => e.className === "step-editor");
    assert.equal(steps.length, 3);
    await input(steps[2], "操作", "核对新步骤");
    let supports = field(steps[2], "支持这一步的经验（至少一项，可多选）");
    supports.children[0].selected = true;
    supports.onchange();
    await click(steps[2], "上移");
    steps = walk(editor).filter((e) => e.className === "step-editor");
    assert.equal(field(steps[1], "操作").value, "核对新步骤");
    await click(steps[0], "添加分支");
    steps = walk(editor).filter((e) => e.className === "step-editor");
    await input(steps[0], "分支条件", "当前文件已存在");
    await input(editor, "修改说明", "核对界面编辑请求");
    await click(editor, "提交审查");
    const revise = requests.findLast((r) => r.operation === "revisePlaybook");
    assert.equal(revise.input.body.steps.length, 3);
    assert.equal(revise.input.body.steps[1].instruction, "核对新步骤");
    assert.equal(revise.input.body.steps[0].choices[0].next, "stop");
    checks.push("add reorder branch and reviewed revision");
    assert.equal(
      walk($("detail")).some((e) => e.textContent === "查看历史"),
      false,
    );
    checks.push("current method only, no historical restore");
    await click($("detail"), "关联宿主任务");
    let taskPanel = $("detail").children.findLast((e) =>
      e.textContent.includes("宿主任务"),
    );
    await click(taskPanel, "获取完整方法");
    assert.ok(taskPanel.textContent.includes("适用条件：使用生成器维护文件"));
    assert.ok(taskPanel.textContent.includes("例外：外部系统只读文件"));
    assert.ok(taskPanel.textContent.includes("生成文件 → 步骤 2"));
    assert.ok(taskPanel.textContent.includes("手工文件 → 停止"));
    assert.ok(
      taskPanel.textContent.includes("完成检查（步骤 2）：字段符合预期"),
    );
    assert.ok(taskPanel.textContent.includes("停止条件（全局）：来源不明"));
    assert.equal(
      requests.findLast((r) => r.operation === "preparePlaybook").input
        .playbookUseRef,
      undefined,
    );
    await click(taskPanel, "评价这次使用");
    await click(taskPanel, "保存评价");
    assert.equal(
      requests.findLast((r) => r.operation === "updateTaskFeedback").input
        .taskRef,
      "task-ui",
    );
    assert.ok(!requests.some((r) => r.operation === "observeTask"));
    checks.push("host task link and use rating without executor");
    await run("renderRecords()");
    await run("renderSources()");
    await click($("source-list"), "补充结果或后续观察");
    await input(
      $("source-list"),
      "实际结果、尝试及可核对的依据",
      "实际读回包含新增字段",
    );
    await click($("source-list"), "提交结果复盘");
    assert.equal(
      requests.findLast((r) => r.operation === "submitSource").input.sourceFor
        .id,
      "source-ui",
    );
    checks.push("source result links current revision");
    await run("showExperience('experience-ui')");
    assert.doesNotMatch($("record-detail").textContent, /undefined|L[1-5]/);
    await click($("record-detail"), "补充证据并审查");
    await input($("record-detail"), "实际原文或观察", "实际文件包含 auditTag");
    await click($("record-detail"), "提交补证");
    assert.equal(
      requests.findLast((r) => r.operation === "submitSource").input
        .verificationFor.revision,
      2,
    );
    checks.push("experience targeted verification");
    $("scope").value = "ui-check";
    $("source").value = "已读取输出，新增来源原文";
    await $("submit").click();
    assert.ok(
      requests
        .findLast((r) => r.operation === "submitSource")
        .input.segments[0].text.includes("新增来源"),
    );
    checks.push("authored source submission");
    await run("show('playbook-ui')");
    await run(
      "current = {...current,supportRefs:[{kind:'experience',id:'experience-ui',revision:1}]}; editPlaybook(document.getElementById('detail'))",
    );
    editor = $("detail").children.findLast((e) =>
      e.textContent.includes("修改说明"),
    );
    let oldRefRequests = requests.filter(
      (r) => r.operation === "revisePlaybook",
    ).length;
    await button(editor, "提交审查").click();
    assert.match($("notice").textContent, /原依据已更新/);
    assert.equal(
      requests.filter((r) => r.operation === "revisePlaybook").length,
      oldRefRequests,
    );
    field(editor, "送审时改用上述当前依据修订（仍需审查）").checked = true;
    await button(editor, "提交审查").click();
    assert.match($("notice").textContent, /依据仍未可用/);
    assert.equal(
      requests.filter((r) => r.operation === "revisePlaybook").length,
      oldRefRequests,
    );
    checks.push(
      "changed or held supporting evidence blocks current submission",
    );
    const realFetch = context.fetch;
    context.fetch = async (path, options) =>
      JSON.parse(options.body).operation === "inspectExperience"
        ? { ok: false, json: async () => ({ error: "not_found" }) }
        : realFetch(path, options);
    await run("editPlaybook(document.getElementById('detail'), current)");
    assert.ok($("detail").textContent.includes("以下依据已不可读取"));
    context.fetch = realFetch;
    checks.push("missing supporting evidence is shown without an editor crash");
    await run("list()");
    await click($("playbook-pages"), "下一页");
    $("playbook-topic").value = "different";
    await click($("playbook-pages"), "上一页");
    assert.equal(
      requests.findLast((r) => r.operation === "browsePlaybooks").input.cursor,
      undefined,
    );
    assert.ok($("playbook-pages").textContent.includes("第 1 页"));
    checks.push("changed filter resets the cursor before any page action");
    await run("show('playbook-ui')");
    await click($("detail"), "关联宿主任务");
    taskPanel = $("detail").children.findLast((e) =>
      e.textContent.includes("宿主任务"),
    );
    const taskSelector = field(taskPanel, "宿主任务");
    let release;
    const blockingFetch = context.fetch;
    context.fetch = async (path, options) => {
      if (JSON.parse(options.body).operation === "preparePlaybook")
        return new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              json: async () => ({
                result: {
                  status: "guidance",
                  feedbackRevision: 2,
                  steps: [],
                  completionChecks: [],
                },
              }),
            });
        });
      return blockingFetch(path, options);
    };
    const pendingPrepare = button(taskPanel, "获取完整方法").click();
    await Promise.resolve();
    taskSelector.value = "new-task";
    taskSelector.onchange();
    release();
    await pendingPrepare;
    assert.ok(!taskPanel.textContent.includes("old-task-use"));
    assert.ok(!walk(taskPanel).some((e) => e._text === "评价这次使用"));
    context.fetch = blockingFetch;
    checks.push(
      "task selection changes discard an in-flight preparation response",
    );
    await nav.find((e) => e.dataset.view === "effects").click();
    assert.match($("effect-cases").textContent, /任务结果：未知/);
    assert.match($("effect-cases").textContent, /投递未知/);
    assert.match($("effect-cases").textContent, /评价：有帮助/);
    checks.push(
      "feedback renders unknown delivery and result independently from a helpful rating",
    );
    assert.doesNotMatch($("effect-summary").textContent, /结果来源/);
    assert.doesNotMatch($("periodic-reviews").textContent, /结果来源/);
    const taskCard = (taskRef) => {
      const card = $("effect-cases").children.find((e) =>
        e.children.some((c) => c._text === taskRef),
      );
      assert.ok(card, "task card " + taskRef);
      return card;
    };
    const outcomeWrites = () =>
      requests.filter(
        (r) =>
          r.operation === "updateTaskFeedback" &&
          r.input.field === "taskOutcome",
      );
    const outcomeTask = {
      id: "session-no-playbook",
      taskRef: "session-no-playbook",
      revision: 1,
      scopeId: "ui-check",
      taskOutcome: "unknown",
      outcomeText: "",
      outcomeScope: "session",
      outcomeAssessment: "pending",
      classification: "needs_verification",
      feedback: [],
    };
    fixture.taskFeedback.set(outcomeTask.id, outcomeTask);
    await run("renderEffects()");
    let outcomeCard = taskCard(outcomeTask.id);
    assert.match(outcomeCard.textContent, /Copilot 会话结果：未知/);
    assert.match(outcomeCard.textContent, /AI 正在判断结果/);
    assert.equal(
      walk(outcomeCard).some((e) => e._text === "确认当前结果"),
      false,
    );
    await click(outcomeCard, "填写或纠正结果");
    assert.deepEqual(
      field(outcomeCard, "结果").options.map((o) => o.value),
      ["succeeded", "failed", "abandoned", "unknown"],
    );
    assert.equal(field(outcomeCard, "结果说明（可选）").maxLength, 512);
    await input(outcomeCard, "结果", "failed");
    await input(outcomeCard, "结果说明（可选）", "构建失败，尚未修复。");
    await click(outcomeCard, "保存结果");
    assert.deepEqual(outcomeWrites().at(-1).input, {
      taskRef: outcomeTask.id,
      field: "taskOutcome",
      expectedRevision: 1,
      taskOutcome: "failed",
      text: "构建失败，尚未修复。",
    });
    assert.match(taskCard(outcomeTask.id).textContent, /人工确认或纠正/);
    assert.doesNotMatch(taskCard(outcomeTask.id).textContent, /AI 正在判断/);
    assert.match($("effect-summary").textContent, /失败 1/);
    assert.match($("periodic-reviews").textContent, /失败 1/);
    checks.push(
      "session outcome can be recorded without a playbook while AI is pending",
    );
    for (const taskOutcome of ["abandoned", "unknown"]) {
      outcomeCard = taskCard(outcomeTask.id);
      const revision = outcomeTask.revision;
      await click(outcomeCard, "填写或纠正结果");
      await input(outcomeCard, "结果", taskOutcome);
      await input(outcomeCard, "结果说明（可选）", "");
      await click(outcomeCard, "保存结果");
      assert.equal(outcomeWrites().at(-1).input.expectedRevision, revision);
      assert.equal(outcomeTask.taskOutcome, taskOutcome);
      assert.equal(outcomeTask.outcomeText, "");
    }
    checks.push(
      "manual corrections support cancellation and unknown with optional text",
    );
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "succeeded",
      outcomeSource: "ai",
      outcomeAssessment: "completed",
      outcomeText: "Copilot 报告已完成修改。",
      outcomeEvidence: [
        { role: "agent", excerpt: "已完成 <script>修改</script>。" },
      ],
    });
    await run("renderEffects()");
    outcomeCard = taskCard(outcomeTask.id);
    assert.match(outcomeCard.textContent, /AI 判断（待人工确认）/);
    assert.ok(
      outcomeCard.textContent.includes(
        "Copilot：已完成 <script>修改</script>。",
      ),
    );
    assert.equal(
      walk(outcomeCard).some((e) => e.tag === "script"),
      false,
    );
    assert.match($("effect-summary").textContent, /AI 判断 1/);
    assert.match($("periodic-reviews").textContent, /AI 判断 1/);
    const confirmRevision = outcomeTask.revision;
    await click(outcomeCard, "确认当前结果");
    assert.equal(
      outcomeWrites().at(-1).input.expectedRevision,
      confirmRevision,
    );
    assert.equal(outcomeWrites().at(-1).input.taskOutcome, "succeeded");
    assert.equal(outcomeTask.outcomeSource, "user");
    assert.match(
      $("effect-summary").textContent,
      /AI 判断 0 · 人工确认或纠正 1/,
    );
    assert.match($("periodic-reviews").textContent, /人工确认或纠正 1/);
    assert.equal(
      walk(taskCard(outcomeTask.id)).some((e) => e._text === "确认当前结果"),
      false,
    );
    checks.push(
      "AI result and literal evidence can be confirmed and refresh review source counts",
    );
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "succeeded",
      outcomeSource: "ai",
    });
    await run("renderEffects()");
    const staleCard = taskCard(outcomeTask.id),
      writesBeforeStale = outcomeWrites().length;
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "failed",
      outcomeSource: "host",
      outcomeText: "宿主报告会话异常结束。",
    });
    await button(staleCard, "确认当前结果").click();
    assert.match($("notice").textContent, /结果已更新，请核对最新记录后再确认/);
    assert.equal(outcomeWrites().length, writesBeforeStale);
    assert.match(
      taskCard(outcomeTask.id).textContent,
      /Copilot 会话结果：失败/,
    );
    assert.match(taskCard(outcomeTask.id).textContent, /宿主报告/);
    checks.push(
      "confirmation refuses a changed displayed revision without writing",
    );
    outcomeCard = taskCard(outcomeTask.id);
    await click(outcomeCard, "填写或纠正结果");
    const formRevision = outcomeTask.revision;
    await input(outcomeCard, "结果", "abandoned");
    await input(outcomeCard, "结果说明（可选）", "我取消了这次会话。");
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "succeeded",
      outcomeSource: "user",
      outcomeText: "另一位用户已确认成功。",
    });
    const beforeConflict = outcomeWrites().length;
    await click(outcomeCard, "保存结果");
    assert.equal(outcomeWrites().length, beforeConflict + 1);
    assert.equal(outcomeWrites().at(-1).input.expectedRevision, formRevision);
    assert.match(outcomeCard.textContent, /草稿尚未保存/);
    assert.equal(button(outcomeCard, "保存结果").disabled, true);
    assert.equal(field(outcomeCard, "结果").value, "abandoned");
    assert.equal(
      field(outcomeCard, "结果说明（可选）").value,
      "我取消了这次会话。",
    );
    await click(outcomeCard, "加载最新结果");
    assert.equal(outcomeWrites().length, beforeConflict + 1);
    assert.match(outcomeCard.textContent, /另一位用户已确认成功/);
    assert.equal(field(outcomeCard, "结果").value, "abandoned");
    assert.equal(
      field(outcomeCard, "结果说明（可选）").value,
      "我取消了这次会话。",
    );
    assert.equal(button(outcomeCard, "保存结果").disabled, false);
    const retryRevision = outcomeTask.revision;
    await click(outcomeCard, "保存结果");
    assert.equal(outcomeWrites().at(-1).input.expectedRevision, retryRevision);
    assert.equal(outcomeTask.taskOutcome, "abandoned");
    checks.push(
      "stale edit preserves draft and requires loading and reviewing before a new save",
    );
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "succeeded",
      outcomeSource: "ai",
    });
    await run("renderEffects()");
    const raceFetch = context.fetch;
    let race = true;
    context.fetch = async (path, options) => {
      const { operation, input } = JSON.parse(options.body);
      if (
        race &&
        operation === "updateTaskFeedback" &&
        input.field === "taskOutcome"
      ) {
        race = false;
        Object.assign(outcomeTask, {
          revision: outcomeTask.revision + 1,
          taskOutcome: "abandoned",
          outcomeSource: "host",
        });
      }
      return raceFetch(path, options);
    };
    await button(taskCard(outcomeTask.id), "确认当前结果").click();
    assert.match($("notice").textContent, /结果已更新，请核对最新记录后再确认/);
    assert.equal(outcomeTask.outcomeSource, "host");
    assert.match(taskCard(outcomeTask.id).textContent, /已取消或放弃/);
    context.fetch = raceFetch;
    checks.push(
      "confirmation handles a write-time revision conflict without automatic retry",
    );
    Object.assign(outcomeTask, {
      revision: outcomeTask.revision + 1,
      taskOutcome: "unknown",
      outcomeSource: undefined,
      outcomeAssessment: "unavailable",
      outcomeText: "",
    });
    await run("renderEffects()");
    assert.match(
      taskCard(outcomeTask.id).textContent,
      /Copilot 会话结果：未知/,
    );
    assert.match(
      taskCard(outcomeTask.id).textContent,
      /自动判断暂不可用，可手动填写结果/,
    );
    assert.doesNotMatch(taskCard(outcomeTask.id).textContent, /会话结果：失败/);
    checks.push(
      "unavailable assessment remains distinct from a failed task result",
    );
    assert.deepEqual(
      $("record-state").options.map((o) => o.value),
      ["", "active", "held", "disabled"],
    );
    $("record-state").value = "active";
    await run("renderRecords()");
    assert.match($("record-cards").textContent, /暂无符合条件/);
    $("record-state").value = "held";
    await run("renderRecords()");
    assert.match($("record-cards").textContent, /重新生成后核对字段与扩展/);
    checks.push("experience status options filter current experience records");

    await run("show('playbook-ui')");
    await click($("detail"), "查看使用记录");
    assert.match($("detail").textContent, /任务结果：未知/);
    assert.match($("detail").textContent, /投递未知 · 评价：有帮助/);
    assert.match($("detail").textContent, /已核对输出/);
    checks.push(
      "playbook usage renders the TaskFeedback contract without event records",
    );

    const baselineFetch = context.fetch;
    context.fetch = async (path, options) => {
      const response = await baselineFetch(path, options);
      if (JSON.parse(options.body).operation !== "inspectPlaybook")
        return response;
      const payload = await response.json();
      payload.result.steps = [
        {
          stepId: "uuid-first",
          instruction: "先读来源",
          supportIndexes: [0],
          choices: [{ when: { text: "来源明确" }, next: "uuid-second" }],
        },
        {
          stepId: "uuid-second",
          instruction: "再核对输出",
          supportIndexes: [0],
        },
      ];
      payload.result.completionChecks = [
        { text: "输出已读回", stepIds: ["uuid-second"] },
      ];
      payload.result.stopConditions = [
        { text: "来源不明", stepIds: ["uuid-first"] },
      ];
      return { ok: true, json: async () => payload };
    };
    await run("show('playbook-ui')");
    assert.match($("detail").textContent, /来源明确 → 步骤 2/);
    assert.match($("detail").textContent, /完成检查（步骤 2）：输出已读回/);
    assert.match($("detail").textContent, /停止条件（步骤 1）：来源不明/);
    assert.doesNotMatch($("detail").textContent, /uuid-first|uuid-second/);
    context.fetch = baselineFetch;
    checks.push(
      "method detail preserves stop conditions and translates step references",
    );

    await run("show('playbook-ui')");
    await click($("detail"), "查看依据");
    await click($("detail"), "为这条经验补充证据");
    await input($("detail"), "实际原文或观察", "  补充核实观察  ");
    await click($("detail"), "提交补证");
    assert.equal(
      requests.findLast((r) => r.operation === "submitSource").input.segments[0]
        .text,
      "补充核实观察",
    );
    await click($("detail"), "查询复盘结果");
    await click($("detail"), "查看最新内容");
    assert.match($("detail").textContent, /核对生成文件/);
    checks.push(
      "supporting experience supplement shares job controls and refreshes its method",
    );

    let savedSettings = {
      id: "ui-check",
      scopeId: "ui-check",
      revision: 0,
      learning: false,
      recommendation: false,
      review: false,
      notifications: false,
    };
    const settingWrites = [];
    let settingsReads = 0;
    context.fetch = async (path, options) => {
      const { operation, input } = JSON.parse(options.body);
      if (operation === "settings.get") {
        settingsReads++;
        const snapshot = structuredClone(savedSettings);
        return {
          ok: true,
          json: async () => ({ result: [snapshot] }),
        };
      }
      if (operation === "settings.update")
        return new Promise((resolve) => settingWrites.push({ input, resolve }));
      return baselineFetch(path, options);
    };
    await run("renderSettings()");
    const controls = walk($("settings-form")).filter((e) => e.tag === "input");
    controls[0].checked = true;
    const saveLearning = controls[0].onchange();
    assert.ok(controls.every((control) => control.disabled));
    controls[1].checked = true;
    await controls[1].onchange();
    assert.equal(settingWrites.length, 1);
    assert.equal(controls[1].checked, false);
    savedSettings = { ...savedSettings, learning: true, revision: 1 };
    settingWrites[0].resolve({
      ok: true,
      json: async () => ({ result: structuredClone(savedSettings) }),
    });
    await saveLearning;
    assert.equal(controls[0].checked, true);
    assert.ok(controls.every((control) => !control.disabled));
    controls[1].checked = true;
    const saveRecommendation = controls[1].onchange();
    assert.equal(settingWrites[1].input.expectedRevision, 1);
    settingWrites[1].resolve({
      ok: false,
      json: async () => ({ error: "revision_conflict" }),
    });
    await saveRecommendation;
    assert.match($("notice").textContent, /revision_conflict/);
    assert.equal(controls[1].checked, false);
    assert.equal(controls[0].checked, true);
    assert.ok(controls.every((control) => !control.disabled));
    checks.push(
      "settings prevent overlapping writes and roll back a failed save",
    );
    const settingsNav = nav.find((item) => item.dataset.view === "settings");
    controls[1].checked = true;
    const retryRecommendation = controls[1].onchange();
    const readsBeforeReentry = settingsReads;
    const reentry = settingsNav.click();
    await Promise.resolve();
    assert.equal(settingsReads, readsBeforeReentry);
    assert.ok(controls.every((control) => control.disabled));
    savedSettings = { ...savedSettings, recommendation: true, revision: 2 };
    settingWrites[2].resolve({
      ok: true,
      json: async () => ({ result: structuredClone(savedSettings) }),
    });
    await Promise.all([retryRecommendation, reentry]);
    let liveControls = walk($("settings-form")).filter(
      (e) => e.tag === "input",
    );
    assert.notEqual(liveControls[0], controls[0]);
    assert.equal(liveControls[0].checked, true);
    assert.equal(liveControls[1].checked, true);
    assert.ok(liveControls.every((control) => !control.disabled));
    checks.push(
      "settings reentry waits for an active save and renders its committed values",
    );

    liveControls[2].checked = true;
    const failedReview = liveControls[2].onchange();
    assert.equal(settingWrites[3].input.expectedRevision, 2);
    const beforeFailedReentry = settingsReads;
    const failedReentry = settingsNav.click(),
      newestReentry = settingsNav.click();
    await Promise.resolve();
    assert.equal(settingsReads, beforeFailedReentry);
    settingWrites[3].resolve({
      ok: false,
      json: async () => ({ error: "offline" }),
    });
    await Promise.all([failedReview, failedReentry, newestReentry]);
    assert.equal(settingsReads, beforeFailedReentry + 1);
    liveControls = walk($("settings-form")).filter((e) => e.tag === "input");
    assert.equal(liveControls[2].checked, false);
    assert.equal(liveControls[1].checked, true);
    assert.ok(liveControls.every((control) => !control.disabled));
    checks.push(
      "failed setting saves release reentry and only the latest navigation renders",
    );

    const settingsFetch = context.fetch,
      delayedSettingsReads = [];
    context.fetch = async (path, options) => {
      if (JSON.parse(options.body).operation === "settings.get") {
        const snapshot = structuredClone(savedSettings);
        return new Promise((resolve) =>
          delayedSettingsReads.push({
            finish: () =>
              resolve({ ok: true, json: async () => ({ result: [snapshot] }) }),
          }),
        );
      }
      return settingsFetch(path, options);
    };
    const staleRead = settingsNav.click();
    liveControls[2].checked = true;
    const saveReview = liveControls[2].onchange();
    savedSettings = { ...savedSettings, review: true, revision: 3 };
    settingWrites[4].resolve({
      ok: true,
      json: async () => ({ result: structuredClone(savedSettings) }),
    });
    await saveReview;
    delayedSettingsReads[0].finish();
    await staleRead;
    assert.equal(
      walk($("settings-form")).find((e) => e.tag === "input"),
      liveControls[0],
    );
    assert.equal(liveControls[2].checked, true);
    const earlierRead = settingsNav.click();
    savedSettings = { ...savedSettings, notifications: true, revision: 4 };
    const laterRead = settingsNav.click();
    delayedSettingsReads[2].finish();
    await laterRead;
    delayedSettingsReads[1].finish();
    await earlierRead;
    liveControls = walk($("settings-form")).filter((e) => e.tag === "input");
    assert.equal(liveControls[3].checked, true);
    context.fetch = baselineFetch;
    checks.push(
      "stale settings reads cannot overwrite a newer save or navigation response",
    );

    $("playbook-topic").value = "";
    $("playbook-state").value = "";
    await $("search").onsubmit({ preventDefault() {} });
    const pageWrites = [];
    context.fetch = async (path, options) => {
      if (JSON.parse(options.body).operation === "browsePlaybooks")
        return new Promise((resolve) =>
          pageWrites.push({
            finish: () => baselineFetch(path, options).then(resolve),
            resolve,
          }),
        );
      return baselineFetch(path, options);
    };
    const pageButton = button($("playbook-pages"), "下一页");
    const nextPage = pageButton.click();
    await pageButton.click();
    assert.equal(pageWrites.length, 1);
    assert.equal(pageButton.disabled, true);
    await pageWrites[0].finish();
    await nextPage;
    assert.match($("playbook-pages").textContent, /第 2 页 · 共 14 项/);
    const previousButton = button($("playbook-pages"), "上一页");
    const failedPage = previousButton.click();
    pageWrites[1].resolve({
      ok: false,
      json: async () => ({ error: "offline" }),
    });
    await failedPage;
    assert.equal(previousButton.disabled, false);
    const retryPage = previousButton.click();
    await pageWrites[2].finish();
    await retryPage;
    assert.match($("playbook-pages").textContent, /第 1 页 · 共 14 项/);
    context.fetch = baselineFetch;
    checks.push(
      "pagination rejects duplicate clicks and retries from the same page after failure",
    );

    const exports = [];
    context.fetch = async (path, options) => {
      const { operation, input } = JSON.parse(options.body);
      if (operation === "reviews.export")
        return new Promise((resolve) => exports.push({ input, resolve }));
      return baselineFetch(path, options);
    };
    await run(
      "exportCaseForm(document.getElementById('effect-cases'), { id: 'task-ui' })",
    );
    const exportPanel = $("effect-cases").children.at(-1),
      exportTerms = field(exportPanel, "需要替换的文字（每行一项）"),
      exportObservations = field(exportPanel, "包含仍保留的工具观察"),
      previewButton = button(exportPanel, "生成预览");
    const finishExport = (index, content, contentRevision = "same") =>
      exports[index].resolve({
        ok: true,
        json: async () => ({
          result: { content, contentRevision, filename: "case.json" },
        }),
      });
    const firstPreview = previewButton.click();
    exportTerms.value = "secret";
    exportTerms.oninput();
    finishExport(0, "secret");
    await firstPreview;
    assert.ok(!walk(exportPanel).some((e) => e._text === "下载已预览样本"));
    assert.doesNotMatch(
      walk(exportPanel).find((e) => e.tag === "pre").textContent,
      /secret/,
    );
    const olderPreview = previewButton.click(),
      newerPreview = previewButton.click();
    finishExport(2, "latest [redacted]");
    await newerPreview;
    finishExport(1, "outdated [redacted]");
    await olderPreview;
    assert.equal(
      walk(exportPanel).find((e) => e.tag === "pre").textContent,
      "latest [redacted]",
    );
    assert.equal(
      walk(exportPanel).filter((e) => e._text === "下载已预览样本").length,
      1,
    );
    checks.push(
      "export ignores obsolete previews after redaction changes and reordered responses",
    );

    let downloads = 0;
    const originalUrl = context.URL;
    context.URL = {
      createObjectURL: () => {
        downloads++;
        return "blob:fixture";
      },
      revokeObjectURL() {},
    };
    const pendingDownload = button(exportPanel, "下载已预览样本").click();
    exportObservations.checked = true;
    exportObservations.onchange();
    finishExport(3, "latest [redacted]");
    await pendingDownload;
    assert.equal(downloads, 0);
    const finalPreview = previewButton.click();
    assert.deepEqual(exports[4].input.redact, ["secret"]);
    assert.equal(exports[4].input.includeObservations, true);
    finishExport(4, "current [redacted]");
    await finalPreview;
    const finalDownload = button(exportPanel, "下载已预览样本").click();
    assert.deepEqual(exports[5].input, exports[4].input);
    finishExport(5, "current [redacted]");
    await finalDownload;
    assert.equal(downloads, 1);
    context.URL = originalUrl;
    context.fetch = baselineFetch;
    checks.push(
      "export cancels a pending download when conditions change and downloads the fresh preview",
    );
    return checks;
  } finally {
    await fixture.close();
  }
}
