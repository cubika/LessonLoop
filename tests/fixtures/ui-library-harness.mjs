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
    await click($("detail"), "查看历史");
    await click($("detail"), "用这版内容修改并送审");
    editor = $("detail").children.findLast((e) =>
      e.textContent.includes("修改说明"),
    );
    assert.equal(field(editor, "名称").value, "旧版生成文件检查");
    await click(editor, "提交审查");
    assert.equal(
      requests.findLast((r) => r.operation === "revisePlaybook").input
        .expectedRevision,
      2,
    );
    checks.push("historical body reviews against current revision");
    await click($("detail"), "关联宿主任务");
    let taskPanel = $("detail").children.findLast((e) =>
      e.textContent.includes("宿主任务"),
    );
    await click(taskPanel, "获取完整方法");
    assert.ok(taskPanel.textContent.includes("适用条件：使用生成器维护文件"));
    assert.ok(taskPanel.textContent.includes("例外：外部系统只读文件"));
    assert.ok(taskPanel.textContent.includes("生成文件 → s2"));
    assert.ok(taskPanel.textContent.includes("手工文件 → 停止"));
    assert.ok(taskPanel.textContent.includes("完成检查（s2）：字段符合预期"));
    assert.ok(taskPanel.textContent.includes("停止条件（全局）：来源不明"));
    assert.equal(
      requests.findLast((r) => r.operation === "preparePlaybook").input
        .playbookUseRef,
      undefined,
    );
    await click(taskPanel, "评价这次使用");
    await click(taskPanel, "保存评价");
    assert.equal(
      requests.findLast((r) => r.operation === "ratePlaybookUse").input.taskRef,
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
    await run("showRecord('experience','experience-ui')");
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
      "editPlaybook(document.getElementById('detail'), {...current,supportRefs:[{kind:'experience',id:'experience-ui',revision:1}]})",
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
      "changed or held supporting evidence blocks historical submission",
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
                  playbookUseRef: "old-task-use",
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
    return checks;
  } finally {
    await fixture.close();
  }
}
