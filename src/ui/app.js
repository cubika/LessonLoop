let token = "",
  current,
  settings = [];
const $ = (id) => document.getElementById(id);
const node = (tag, text) => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
async function rpc(operation, input = {}) {
  const r = await fetch("/v1/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ operation, input }),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error);
  return v.result;
}
const handle = (fn) => async (event) => {
  try {
    $("notice").textContent = "";
    await fn(event);
  } catch (e) {
    $("notice").textContent = e.message;
  }
};
$("connect").onclick = handle(async () => {
  token = $("token").value;
  settings = await rpc("settings.get");
  $("login").hidden = true;
  $("workspace").hidden = false;
  await list();
  await renderReviewNotifications();
});
async function list() {
  const methods = await rpc("browseMethods", { query: $("query").value });
  $("cards").replaceChildren();
  if (!methods.length)
    $("cards").append(
      node("p", "暂无方法。提交有价值的工作片段后，可在这里查看复盘结果。"),
    );
  for (const method of methods) {
    const card = node("section", "");
    card.className = "card";
    card.append(
      node("h2", method.title),
      node("p", method.goal),
      node("span", `${method.state} · 修订 ${method.revision}`),
    );
    card.onclick = handle(() => show(method.id));
    $("cards").append(card);
  }
}
$("search").onsubmit = handle(async (e) => {
  e.preventDefault();
  await list();
});
async function show(id) {
  current = await rpc("inspectMethod", { id });
  const d = $("detail");
  d.replaceChildren(node("h2", current.title), node("p", current.goal));
  for (const [label, key] of [
    ["适用条件", "conditions"],
    ["例外", "exceptions"],
  ])
    if (current[key].length) {
      d.append(node("h3", label));
      const ul = node("ul", "");
      current[key].forEach((v) => ul.append(node("li", v.text)));
      d.append(ul);
    }
  const steps = node("ol", "");
  for (const s of current.steps) {
    const li = node("li", s.instruction);
    if (s.choices)
      li.append(
        node(
          "pre",
          s.choices.map((c) => `${c.when.text} → ${c.next}`).join("\n"),
        ),
      );
    steps.append(li);
  }
  d.append(steps, node("h3", "完成检查"));
  current.completionChecks.forEach((c) => d.append(node("p", c.text)));
  d.append(node("h3", "最近变化"), node("p", current.change.summary));
  const state = node(
    "button",
    current.state === "disabled" ? "重新检查并启用" : "停用",
  );
  state.onclick = handle(async () => {
    await rpc("setMethodState", {
      id,
      expectedRevision: current.revision,
      state: current.state === "disabled" ? "active" : "disabled",
    });
    await show(id);
    await list();
  });
  const history = node("button", "查看历史");
  history.onclick = handle(async () => {
    const versions = await rpc("methodHistory", { id });
    const panel = node("section", "");
    panel.append(node("h3", "修订比较"));
    if (!versions.length) panel.append(node("p", "暂无保留的历史修订。"));
    for (const version of versions) {
      const details = node("details", "");
      details.append(
        node("summary", `修订 ${version.revision} → ${current.revision}`),
      );
      for (const [key, label] of [
        ["goal", "目标"],
        ["steps", "步骤和分支"],
        ["conditions", "条件"],
        ["exceptions", "例外"],
        ["completionChecks", "完成检查"],
        ["state", "状态"],
      ])
        if (JSON.stringify(version[key]) !== JSON.stringify(current[key]))
          details.append(
            node("h4", label),
            node(
              "pre",
              `此前：${JSON.stringify(version[key], null, 2)}\n现在：${JSON.stringify(current[key], null, 2)}`,
            ),
          );
      panel.append(details);
    }
    d.append(panel);
  });
  d.append(state, history);
  const edit = node("button", "修改方法");
  edit.onclick = handle(() => editMethod(d));
  const prepare = node("button", "为新任务准备");
  prepare.onclick = handle(() => prepareMethod(d));
  const evidence = node("button", "查看依据");
  evidence.onclick = handle(async () => {
    const panel = node("section", "");
    panel.append(node("h3", "方法依据"));
    for (const support of current.supportRefs) {
      const value = await rpc("inspect", { id: support.id });
      panel.append(
        node(
          "p",
          `${value.level} · ${value.assessment} · 修订 ${value.revision}`,
        ),
        node("p", value.conclusion),
      );
      value.evidence.forEach((e) =>
        panel.append(node("blockquote", `[${e.role}] ${e.excerpt}`)),
      );
    }
    d.append(panel);
  });
  d.append(edit, prepare, evidence);
  const format = node("select", "");
  format.setAttribute("aria-label", "导出格式");
  for (const [value, label] of [
    ["markdown", "Markdown"],
    ["checklist", "检查清单"],
    ["skill", "Skill"],
  ]) {
    const option = node("option", label);
    option.value = value;
    format.append(option);
  }
  const exportButton = node("button", "导出快照");
  exportButton.onclick = handle(async () => {
    const result = await rpc("exportMethod", {
      id,
      revision: current.revision,
      format: format.value,
      includeEvidence: false,
    });
    const blob = new Blob([result.content], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = node("a", "下载方法快照");
    link.href = url;
    link.download = result.filename;
    link.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 30000);
    d.append(node("p", "导出是独立快照，后续修订不会同步更新。"), link);
  });
  d.append(format, exportButton);
}
document.querySelectorAll("[data-view]").forEach(
  (button) =>
    (button.onclick = handle(async () => {
      [
        "methods",
        "materials",
        "settings",
        "effects",
        "sources",
        "connections",
      ].forEach((id) => ($(id).hidden = id !== button.dataset.view));
      if (button.dataset.view === "settings") await renderSettings();
      if (button.dataset.view === "sources") await renderSources();
      if (button.dataset.view === "connections") await renderConnections();
      if (button.dataset.view === "effects") {
        await renderPeriodicReviews();
        const summary = await rpc("getEffectSummary");
        $("effect-summary").replaceChildren(
          node(
            "p",
            `任务 ${summary.tasks} · 已投递 ${summary.delivered} · 成功 ${summary.succeeded} · 失败 ${summary.failed} · 结果未知 ${summary.unknownOutcome}`,
          ),
        );
        const cases = await rpc("listEffectCases");
        $("effect-cases").replaceChildren(
          ...cases.map((c) => {
            const section = node("section", "");
            section.className = "card";
            section.append(node("h2", c.classification), node("p", c.taskRef));
            c.events.forEach((e) => section.append(node("p", e.text)));
            return section;
          }),
        );
      }
    })),
);
async function renderSettings() {
  settings = await rpc("settings.get");
  const form = $("settings-form");
  form.replaceChildren();
  for (const s of settings) {
    const section = node("section", "");
    section.append(node("h2", s.scopeId));
    for (const [key, label] of [
      ["learning", "从新工作材料中学习"],
      ["recommendation", "新任务自动推荐方法"],
      ["review", "记录使用结果与效果回顾"],
      ["notifications", "显示回顾提醒"],
    ]) {
      const l = node("label", label);
      const i = node("input", "");
      i.type = "checkbox";
      i.checked = s[key];
      i.onchange = handle(async () => {
        s[key] = i.checked;
        const { id, revision, ...body } = s;
        const saved = await rpc("settings.update", {
          ...body,
          expectedRevision: revision,
        });
        Object.assign(s, saved);
      });
      l.prepend(i);
      section.append(l);
    }
    form.append(section);
  }
}
function field(parent, label, value, multiline = false) {
  const wrapper = node("label", label),
    input = node(multiline ? "textarea" : "input", "");
  input.value = value;
  if (multiline) input.rows = 4;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
function editMethod(parent) {
  const method = structuredClone(current),
    panel = node("section", "");
  panel.append(
    node("h3", "修改方法"),
    node("p", "提交后暂停旧建议，依据审查通过后再启用新修订。"),
  );
  const title = field(panel, "名称", method.title),
    goal = field(panel, "目标", method.goal, true);
  const editConditions = (input, original) =>
    input.value
      .split("\n")
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => original.find((c) => c.text === text) ?? { text });
  const conditions = field(
    panel,
    "适用条件（每行一项）",
    method.conditions.map((c) => c.text).join("\n"),
    true,
  );
  const exceptions = field(
    panel,
    "例外（每行一项）",
    method.exceptions.map((c) => c.text).join("\n"),
    true,
  );
  const instructions = method.steps.map((step) => ({
    step,
    input: field(panel, `步骤 ${step.stepId}`, step.instruction, true),
  }));
  const checks = field(
    panel,
    "完成检查（每行一项）",
    method.completionChecks.map((c) => c.text).join("\n"),
    true,
  );
  const reason = field(panel, "修改说明", "", true);
  const save = node("button", "提交审查"),
    cancel = node("button", "取消");
  cancel.onclick = () => panel.remove();
  save.onclick = handle(async () => {
    const checkTexts = checks.value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    const result = await rpc("reviseMethod", {
      id: method.id,
      expectedRevision: method.revision,
      body: {
        title: title.value,
        goal: goal.value,
        conditions: editConditions(conditions, method.conditions),
        exceptions: editConditions(exceptions, method.exceptions),
        applicability:
          conditions.value.trim() || exceptions.value.trim()
            ? "conditional"
            : "general",
        steps: instructions.map(({ step, input }) => ({
          ...step,
          instruction: input.value,
        })),
        completionChecks: checkTexts.map((text, index) => ({
          ...method.completionChecks[index],
          text,
        })),
        change: { ...method.change, kind: "correction", summary: reason.value },
      },
    });
    await show(method.id);
    await list();
    const status = node("p", "修改已接收，新修订等待审查。"),
      refresh = node("button", "检查审查结果");
    refresh.onclick = handle(async () => {
      const review = await rpc("getRevisionReview", { id: result.reviewId });
      status.textContent = `审查：${review.status}${review.reason ? " · " + review.reason : ""}`;
      await list();
    });
    $("detail").append(status, refresh);
  });
  panel.append(save, cancel);
  parent.append(panel);
}
async function prepareMethod(parent) {
  const method = structuredClone(current),
    task = await rpc("startTask", {
      scopeId: method.scopeId,
      eventId: crypto.randomUUID(),
    });
  const panel = node("section", "");
  panel.append(node("h3", "本次任务的方法"));
  parent.append(panel);
  let use;
  const prepare = async () => {
    const result = await rpc("prepareMethod", {
      methodId: method.id,
      revision: method.revision,
      taskRef: task.taskRef,
      ...(use ? { methodUseRef: use } : {}),
      requestId: crypto.randomUUID(),
    });
    use = result.methodUseRef ?? use;
    panel.replaceChildren(node("h3", "本次任务的方法"));
    if (result.status === "lead") {
      panel.append(node("p", "需要先核实以下条件，再准备步骤。"));
      result.missingChecks.forEach((c) =>
        panel.append(node("p", c.text ?? c.question ?? String(c))),
      );
    } else if (result.status === "guidance") {
      const steps = node("ol", "");
      result.steps.forEach((s) => steps.append(node("li", s.instruction)));
      panel.append(steps);
      if (result.pendingDecision)
        panel.append(node("p", "取得实际观察后才能选择后续分支。"));
      result.completionChecks.forEach((c) =>
        panel.append(node("p", `完成检查：${c.text}`)),
      );
    } else
      panel.append(
        node(
          "p",
          `准备结果：${result.status}${result.reason ? " · " + result.reason : ""}`,
        ),
      );
    const refresh = node("button", "重新准备");
    refresh.onclick = handle(prepare);
    const end = node("button", "结束本次任务");
    end.onclick = handle(async () => {
      await rpc("observeTask", {
        taskRef: task.taskRef,
        eventId: crypto.randomUUID(),
        text: "用户结束显式准备任务",
        values: {},
        completedStepIds: [],
        conditionResults: {},
        ended: true,
      });
      panel.replaceChildren(node("p", "本次任务已结束。"));
    });
    panel.append(refresh, end);
  };
  await prepare();
}
async function renderSources() {
  const container = $("source-list");
  container.replaceChildren();
  for (const source of await rpc("listSources")) {
    const card = node("section", "");
    card.className = "card";
    card.append(
      node("h2", `来源 ${source.id.slice(0, 12)}`),
      node(
        "p",
        `${source.scopeId} · ${source.erased ? "副本已擦除" : source.blocked ? "已撤回" : "可用"}${source.excluded ? " · 永久拒收" : ""}`,
      ),
    );
    for (const [action, label] of [
      ["withdraw", "撤回"],
      ["erase", "擦除副本"],
      ["forget", "永久忘记"],
    ]) {
      const button = node("button", label);
      button.disabled =
        source.excluded ||
        (action === "withdraw" && source.blocked) ||
        (action === "erase" && source.erased);
      button.onclick = handle(async () => {
        if (
          action !== "withdraw" &&
          !confirm(
            `${label}此来源？服务中的相关副本会被清除，已另存的导出不受影响。`,
          )
        )
          return;
        const result = await rpc("controlSource", {
          id: source.id,
          expectedRevision: source.revision,
          action,
        });
        const status = node("p", "已停止使用，正在处理清理。"),
          refresh = node("button", "检查清理进度");
        refresh.onclick = handle(async () => {
          const cleanup = await rpc("getSourceCleanup", {
            id: result.cleanupId,
          });
          status.textContent = `${cleanup.status}${cleanup.lastError ? " · " + cleanup.lastError : ""}`;
        });
        card.append(status, refresh);
        button.disabled = true;
      });
      card.append(button);
    }
    container.append(card);
  }
  if (!container.children.length) container.append(node("p", "暂无材料来源。"));
}
async function renderConnections() {
  const container = $("connection-list");
  container.replaceChildren();
  for (const connection of await rpc("connector.list")) {
    const card = node("section", "");
    card.className = "card";
    card.append(
      node("h2", connection.file),
      node(
        "p",
        `${connection.scopeId} · ${connection.status} · 已接收 ${connection.cursor} 项`,
      ),
    );
    if (connection.lastError) card.append(node("p", connection.lastError));
    if (connection.status !== "removed") {
      const state = node(
        "button",
        connection.status === "active" ? "暂停" : "恢复",
      );
      state.onclick = handle(async () => {
        await rpc("connector.state", {
          id: connection.id,
          expectedRevision: connection.revision,
          status: connection.status === "active" ? "paused" : "active",
        });
        await renderConnections();
      });
      const sync = node("button", "立即同步");
      sync.disabled = connection.status !== "active";
      sync.onclick = handle(async () => {
        const result = await rpc("connector.sync", { id: connection.id });
        await renderConnections();
        $("notice").textContent =
          `同步：${result.status}，本轮处理 ${result.results?.length ?? 0} 项。`;
      });
      const remove = node("button", "移除接入");
      remove.onclick = handle(async () => {
        await rpc("connector.state", {
          id: connection.id,
          expectedRevision: connection.revision,
          status: "removed",
        });
        await renderConnections();
      });
      card.append(state, sync, remove);
    }
    const bindings = await rpc("connector.bindings", { id: connection.id });
    for (const binding of bindings) {
      const row = node(
        "p",
        `${binding.sourceKey} · 来源修订 ${binding.sourceRevision} · ${binding.excluded ? "已忘记" : (binding.learningStatus ?? "等待学习")}`,
      );
      const forget = node("button", "忘记来源");
      forget.disabled = binding.excluded;
      forget.onclick = handle(async () => {
        if (!confirm(`永久忘记 ${binding.sourceKey} 及其子来源？`)) return;
        await rpc("connector.forget", {
          id: connection.id,
          sourceKey: binding.sourceKey,
        });
        await renderConnections();
      });
      row.append(forget);
      if (
        !binding.excluded &&
        ["failed", "canceled"].includes(binding.learningStatus)
      ) {
        const retry = node("button", "重试学习");
        retry.onclick = handle(async () => {
          await rpc("connector.retry", { id: binding.id });
          await renderConnections();
        });
        row.append(retry);
      }
      card.append(row);
    }
    container.append(card);
  }
}
$("refresh-sources").onclick = handle(renderSources);
$("refresh-connections").onclick = handle(renderConnections);
$("add-connection").onclick = handle(async () => {
  const result = await rpc("connector.add", {
    scopeId: $("connection-scope").value,
    file: $("connection-file").value,
  });
  await renderConnections();
  $("notice").textContent =
    `已添加，初始范围为所选文件全部 ${result.preview.changes} 项。连接保持暂停，恢复后可同步。`;
});
$("submit").onclick = handle(async () => {
  const r = await rpc("submitMaterial", {
    scopeId: $("scope").value,
    segments: [{ text: $("material").value, role: "user" }],
  });
  $("job").textContent = `已接收。作业 ${r.jobId}`;
  const poll = async () => {
    try {
      const j = await rpc("getJob", { id: r.jobId });
      $("job").textContent = JSON.stringify(j, null, 2);
      if (["queued", "running", "uncertain"].includes(j.status))
        setTimeout(poll, 4000);
      else await list();
    } catch (e) {
      $("job").textContent = e.message;
    }
  };
  await poll();
});

async function renderReviewNotifications() {
  const container = $("review-notifications");
  container.replaceChildren();
  for (const note of await rpc("reviews.notifications")) {
    const row = node("p", note.text),
      dismiss = node("button", "标为已读");
    dismiss.onclick = handle(async () => {
      await rpc("reviews.dismiss", { id: note.id });
      await renderReviewNotifications();
    });
    row.append(dismiss);
    container.append(row);
  }
}
async function renderPeriodicReviews() {
  await renderReviewNotifications();
  const container = $("periodic-reviews");
  container.replaceChildren();
  for (const review of await rpc("reviews.list")) {
    const card = node("section", "");
    card.className = "card";
    card.append(
      node("h3", review.start.slice(0, 10) + " 至 " + review.end.slice(0, 10)),
      node("p", review.scopeId + " · 合并 " + review.mergedPeriods + " 个周期"),
    );
    const stats = review.summary;
    card.append(
      node(
        "p",
        "任务 " +
          stats.tasks +
          " · 成功 " +
          stats.succeeded +
          " · 失败 " +
          stats.failed +
          " · 放弃 " +
          stats.abandoned +
          " · 结果未知 " +
          stats.unknownOutcome,
      ),
    );
    review.methods.forEach((m) =>
      card.append(node("p", "方法变化：" + m.title + " · 修订 " + m.revision)),
    );
    card.append(
      node(
        "p",
        "有帮助反馈 " +
          review.summary.helpfulCount +
          " · 问题反馈 " +
          review.summary.problemCount +
          " · 待核实 " +
          review.needsVerification.length,
      ),
    );
    container.append(card);
  }
  if (!container.children.length)
    container.append(
      node("p", "暂无周期回顾。开启回顾后，每 7 天汇总一次有新内容的周期。"),
    );
}

setInterval(() => {
  if (token && !document.hidden)
    void renderReviewNotifications().catch(() => {});
}, 60000);
