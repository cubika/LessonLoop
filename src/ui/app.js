let token = "",
  current,
  settings = [],
  methodCursors = [undefined],
  methodPage = 0,
  methodFilterKey = "",
  methodListRequest = 0,
  recordPage = 0;
const pageSize = 12;
const labels = {
  active: "可用",
  held: "待核实",
  disabled: "已停用",
  succeeded: "成功",
  failed: "失败",
  partial: "部分完成",
  abandoned: "已放弃",
  unknown: "结果未知",
};
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
  $("token").value = "";
  for (const id of ["method-scope", "record-scope"])
    for (const setting of settings) {
      const option = node("option", setting.scopeId);
      option.value = setting.scopeId;
      $(id).append(option);
    }
  $("login").hidden = true;
  $("workspace").hidden = false;
  await list();
  await renderReviewNotifications();
});
// The launcher supplies the local credential in a URL fragment, never in an HTTP request.
if (
  typeof window !== "undefined" &&
  window.location.hash.startsWith("#token=")
) {
  const credential = new URLSearchParams(window.location.hash.slice(1)).get(
    "token",
  );
  window.history.replaceState(null, "", window.location.pathname);
  if (credential) {
    $("token").value = credential;
    void $("connect").onclick();
  }
}
async function list() {
  const filter = {
    query: $("query").value,
    ...($("method-scope").value ? { scopeIds: [$("method-scope").value] } : {}),
    ...($("method-topic").value.trim()
      ? { topic: $("method-topic").value.trim() }
      : {}),
    ...($("method-state").value ? { state: $("method-state").value } : {}),
    ...($("method-pinned").checked ? { pinnedOnly: true } : {}),
  };
  const filterKey = JSON.stringify(filter);
  if (filterKey !== methodFilterKey) {
    methodFilterKey = filterKey;
    methodCursors = [undefined];
    methodPage = 0;
  }
  const request = ++methodListRequest;
  const result = await rpc("browsePlaybooks", {
    ...filter,
    limit: pageSize,
    ...(methodCursors[methodPage] ? { cursor: methodCursors[methodPage] } : {}),
  });
  if (request !== methodListRequest) return;
  const methods = result.items;
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
      node(
        "span",
        `${labels[method.state]} · ${method.scopeId} · 修订 ${method.revision}`,
      ),
    );
    const pin = node("button", method.pinned ? "取消常用" : "设为常用");
    pin.setAttribute("aria-pressed", String(method.pinned));
    pin.onclick = handle(async (event) => {
      event.stopPropagation();
      await rpc("pinPlaybook", { id: method.id, pinned: !method.pinned });
      methodPage = 0;
      methodCursors = [undefined];
      await list();
    });
    card.append(pin);
    card.tabIndex = 0;
    card.onkeydown = (event) => {
      if (event.target === card && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        card.click();
      }
    };
    card.onclick = handle(() => show(method.id));
    $("cards").append(card);
  }
  const previous = node("button", "上一页"),
    next = node("button", "下一页");
  previous.disabled = methodPage === 0;
  next.disabled = !result.nextCursor;
  previous.onclick = handle(async () => {
    methodPage--;
    await list();
  });
  next.onclick = handle(async () => {
    methodCursors[++methodPage] = result.nextCursor;
    await list();
  });
  $("method-pages").replaceChildren(
    previous,
    node("span", `第 ${methodPage + 1} 页 · 共 ${result.total} 项`),
    next,
  );
}
$("search").onsubmit = handle(async (e) => {
  e.preventDefault();
  methodCursors = [undefined];
  methodPage = 0;
  await list();
});
async function show(id) {
  current = await rpc("inspectPlaybook", { id });
  const d = $("detail");
  d.replaceChildren(node("h2", current.title), node("p", current.goal));
  d.append(
    node(
      "p",
      `${labels[current.state]} · ${current.scopeId} · 修订 ${current.revision}`,
    ),
  );
  const reference = field(
    d,
    "方法引用（可带回宿主任务）",
    JSON.stringify({
      kind: "playbook",
      id: current.id,
      revision: current.revision,
    }),
  );
  reference.readOnly = true;
  reference.className = "reference";
  reference.onclick = () => reference.select();
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
    await rpc("setPlaybookState", {
      id,
      expectedRevision: current.revision,
      state: current.state === "disabled" ? "active" : "disabled",
    });
    await show(id);
    await list();
  });
  d.append(state);
  addWorkView(d, { kind: "playbook", id });
  const usage = node("button", "查看使用记录");
  usage.onclick = handle(async () => {
    const rows = await rpc("getUsageView", { playbookId: id });
    const panel = node("section", "");
    panel.append(node("h3", "使用记录"));
    if (!rows.length) panel.append(node("p", "暂无保留的使用记录。"));
    for (const row of rows) {
      panel.append(node("h4", row.taskRef));
      row.events.forEach((event) => panel.append(node("p", event.text)));
    }
    d.append(panel);
  });
  d.append(usage);
  const edit = node("button", "修改方法");
  edit.onclick = handle(() => editMethod(d));
  const prepare = node("button", "关联宿主任务");
  prepare.onclick = handle(() => preparePlaybook(d));
  const evidence = node("button", "查看依据");
  evidence.onclick = handle(async () => {
    const panel = node("section", "");
    panel.append(node("h3", "方法依据"));
    for (const support of current.supportRefs) {
      const value = await rpc("inspectExperience", { id: support.id });
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
      if (value.state === "held") {
        const supplement = node("button", "为这条经验补充证据");
        supplement.onclick = handle(() => {
          const form = node("section", "");
          form.append(
            node(
              "p",
              value.review?.question ??
                "补充可核对的观察；提交不等于证据通过。",
            ),
          );
          const text = field(form, "实际原文或观察", "", true);
          const send = node("button", "提交补证");
          send.onclick = handle(async () => {
            const receipt = await rpc("submitSource", {
              scopeId: value.scopeId,
              verificationFor: {
                kind: "experience",
                id: value.id,
                revision: value.revision,
              },
              segments: [{ text: text.value, role: "user" }],
            });
            form.replaceChildren(
              node("p", "补证已接收，作业 " + receipt.jobId),
            );
            const check = node("button", "查询补证结果");
            check.onclick = handle(async () =>
              form.append(
                node(
                  "pre",
                  JSON.stringify(
                    await rpc("getJob", { id: receipt.jobId }),
                    null,
                    2,
                  ),
                ),
              ),
            );
            form.append(check);
          });
          form.append(send);
          panel.append(form);
        });
        panel.append(supplement);
      }
    }
    d.append(panel);
  });
  d.append(edit, prepare, evidence);
  const feedback = node("button", "评价或报告错误");
  feedback.onclick = handle(() =>
    feedbackForm(d, "playbook", current, () => show(id)),
  );
  const remove = node("button", "删除方法");
  remove.onclick = handle(async () => {
    if (!confirm("删除这个方法？删除后将不再推荐它。")) return;
    await rpc("removePlaybook", { id, expectedRevision: current.revision });
    d.replaceChildren(node("p", "方法已删除。"));
    await list();
  });
  d.append(feedback, remove);
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
    const result = await rpc("exportPlaybook", {
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
      document
        .querySelectorAll("[data-view]")
        .forEach((item) =>
          item.setAttribute("aria-current", item === button ? "page" : "false"),
        );
      [
        "methods",
        "records",
        "settings",
        "effects",
        "sources",
        "connections",
      ].forEach((id) => ($(id).hidden = id !== button.dataset.view));
      if (button.dataset.view === "settings") await renderSettings();
      if (button.dataset.view === "records") await renderRecords();
      if (button.dataset.view === "sources") await renderSources();
      if (button.dataset.view === "connections") await renderConnections();
      if (button.dataset.view === "effects") {
        await renderPeriodicReviews();
        await renderIssues();
        const summary = await rpc("getEffectSummary");
        $("effect-summary").replaceChildren(
          node(
            "p",
            `任务 ${summary.tasks} · 已投递 ${summary.delivered} · 成功 ${summary.succeeded} · 失败 ${summary.failed} · 结果未知 ${summary.unknownOutcome}`,
          ),
        );
        const cases = await rpc("getUsageView");
        $("effect-cases").replaceChildren(
          ...cases.map((c) => {
            const section = node("section", "");
            section.className = "card";
            section.append(node("h2", c.classification), node("p", c.taskRef));
            c.events.forEach((e) => section.append(node("p", e.text)));
            const report = node("button", "标记方法问题");
            report.onclick = handle(() => issueForm(section, c));
            section.append(report);
            const exportCase = node("button", "导出开发样本");
            exportCase.onclick = handle(() => exportCaseForm(section, c));
            section.append(exportCase);
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
function selectField(parent, label, options, value) {
  const wrapper = node("label", label),
    input = node("select", "");
  for (const [key, text] of options) {
    const option = node("option", text);
    option.value = key;
    input.append(option);
  }
  if (value !== undefined) input.value = value;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
async function editMethod(parent) {
  const latest = structuredClone(current),
    method = structuredClone(current),
    panel = node("section", "");
  panel.append(
    node("h3", "修改方法"),
    node("p", "先自动检查修改内容，通过后替换当前方法；未通过时保留当前内容。"),
  );
  parent.append(panel);
  const title = field(panel, "名称", method.title),
    goal = field(panel, "目标", method.goal, true),
    topics = field(panel, "主题（每行一项）", method.topics.join("\n"), true);
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
  const loadedSupport = await Promise.allSettled(
    method.supportRefs.map((ref) => rpc("inspectExperience", { id: ref.id })),
  );
  const missing = loadedSupport.flatMap((result, index) =>
    result.status === "rejected" ? [method.supportRefs[index].id] : [],
  );
  if (missing.length) {
    panel.append(
      node(
        "p",
        `以下依据已不可读取，无法安全提交这版内容：${missing.join("、")}。请先在经验页核对来源。`,
      ),
    );
    return;
  }
  const support = loadedSupport.map((result) => result.value),
    outdated = support.filter(
      (experience, index) =>
        experience.revision !== method.supportRefs[index].revision,
    );
  let updateSupport;
  if (outdated.length) {
    panel.append(node("h4", "原依据已更新"));
    for (const experience of outdated)
      panel.append(
        node(
          "p",
          `${experience.conclusion} · 当前修订 ${experience.revision} · ${labels[experience.state]}`,
        ),
      );
    updateSupport = field(panel, "送审时改用上述当前依据修订（仍需审查）", "");
    updateSupport.type = "checkbox";
    panel.append(node("p", "请先核对当前依据，再勾选送审。旧依据不会被恢复。"));
  }
  const stepArea = node("div", ""),
    checkArea = node("div", "");
  panel.append(
    node("h4", "步骤与分支"),
    node("p", "没有分支时按顺序进入下一步。每个分支只能指向后续步骤或结束。"),
    stepArea,
  );
  const checkGroups = [
    { key: "completionChecks", title: "完成检查", required: true },
    { key: "stopConditions", title: "停止条件", required: false },
  ];
  const renderChecks = () => {
    checkArea.replaceChildren();
    for (const group of checkGroups) {
      const area = node("div", "");
      area.append(node("h4", group.title));
      method[group.key].forEach((check, index) => {
        const row = node("div", "");
        row.className = "branch-editor";
        const text = field(row, group.title, check.text, true);
        text.oninput = () => {
          check.text = text.value;
        };
        const targets = selectField(
          row,
          "适用步骤（不选表示整个方法，可多选）",
          method.steps.map((s, i) => [
            s.stepId,
            `步骤 ${i + 1}：${s.instruction.slice(0, 55)}`,
          ]),
        );
        targets.multiple = true;
        for (const option of targets.options)
          option.selected = check.stepIds?.includes(option.value) ?? false;
        targets.onchange = () => {
          const chosen = [...targets.selectedOptions].map(
            (option) => option.value,
          );
          if (chosen.length) check.stepIds = chosen;
          else delete check.stepIds;
        };
        const remove = node("button", "移除");
        remove.disabled = group.required && method[group.key].length === 1;
        remove.onclick = () => {
          method[group.key].splice(index, 1);
          renderChecks();
        };
        row.append(remove);
        area.append(row);
      });
      const add = node("button", `添加${group.title}`);
      add.disabled = method[group.key].length >= 4;
      add.onclick = () => {
        method[group.key].push({ text: "" });
        renderChecks();
      };
      area.append(add);
      checkArea.append(area);
    }
  };
  const renderSteps = () => {
    stepArea.replaceChildren();
    method.steps.forEach((step, index) => {
      const row = node("div", "");
      row.className = "step-editor";
      row.append(node("h4", `步骤 ${index + 1}`));
      const instruction = field(row, "操作", step.instruction, true);
      instruction.oninput = () => {
        step.instruction = instruction.value;
      };
      const rationale = field(row, "理由（可选）", step.rationale ?? "");
      rationale.oninput = () => {
        if (rationale.value.trim()) step.rationale = rationale.value;
        else delete step.rationale;
      };
      const sources = selectField(
        row,
        "支持这一步的经验（至少一项，可多选）",
        support.map((e, i) => [
          String(i),
          `${e.conclusion} · 当前修订 ${e.revision}${e.revision !== method.supportRefs[i].revision ? "（已更新，提交前需确认）" : ""}`,
        ]),
      );
      sources.multiple = true;
      for (const option of sources.options)
        option.selected = step.supportIndexes.includes(Number(option.value));
      sources.onchange = () => {
        step.supportIndexes = [...sources.selectedOptions].map((o) =>
          Number(o.value),
        );
      };
      for (const [offset, label] of [
        [-1, "上移"],
        [1, "下移"],
      ]) {
        const move = node("button", label);
        move.disabled =
          index + offset < 0 || index + offset >= method.steps.length;
        move.onclick = () => {
          [method.steps[index], method.steps[index + offset]] = [
            method.steps[index + offset],
            method.steps[index],
          ];
          renderSteps();
          renderChecks();
        };
        row.append(move);
      }
      const remove = node("button", "删除步骤");
      remove.disabled = method.steps.length === 1;
      remove.onclick = handle(() => {
        if (
          method.steps.some(
            (s) => s !== step && s.choices?.some((c) => c.next === step.stepId),
          ) ||
          [...method.completionChecks, ...method.stopConditions].some((c) =>
            c.stepIds?.includes(step.stepId),
          )
        )
          throw new Error("这个步骤仍被分支或检查引用，请先修改这些引用。");
        method.steps.splice(index, 1);
        renderSteps();
        renderChecks();
      });
      row.append(remove);
      for (const [choiceIndex, choice] of (step.choices ?? []).entries()) {
        const branch = node("div", "");
        branch.className = "branch-editor";
        const when = field(branch, "分支条件", choice.when.text);
        when.oninput = () => {
          choice.when = { text: when.value };
        };
        const candidates = [
          ["stop", "结束"],
          ...method.steps
            .slice(index + 1)
            .map((s, i) => [
              s.stepId,
              `步骤 ${index + i + 2}：${s.instruction.slice(0, 55)}`,
            ]),
        ];
        if (!candidates.some(([id]) => id === choice.next))
          candidates.unshift([choice.next, "原目标已在前方，请重新选择"]);
        const next = selectField(branch, "满足条件后", candidates, choice.next);
        next.onchange = () => {
          choice.next = next.value;
        };
        const removeChoice = node("button", "删除分支");
        removeChoice.onclick = () => {
          step.choices.splice(choiceIndex, 1);
          if (!step.choices.length) delete step.choices;
          renderSteps();
        };
        branch.append(removeChoice);
        row.append(branch);
      }
      const branch = node("button", "添加分支");
      branch.disabled = (step.choices?.length ?? 0) >= 4;
      branch.onclick = () => {
        (step.choices ??= []).push({ when: { text: "" }, next: "stop" });
        renderSteps();
      };
      row.append(branch);
      stepArea.append(row);
    });
  };
  renderSteps();
  const addStep = node("button", "添加步骤");
  addStep.onclick = handle(() => {
    if (method.steps.length >= 12)
      throw new Error("一个方法最多 12 步，请拆成独立方法。");
    method.steps.push({
      stepId: crypto.randomUUID(),
      instruction: "",
      supportIndexes: [],
    });
    renderSteps();
    renderChecks();
  });
  panel.append(addStep, checkArea);
  renderChecks();
  const reason = field(panel, "修改说明", "", true);
  const save = node("button", "提交审查"),
    cancel = node("button", "取消");
  cancel.onclick = () => panel.remove();
  save.onclick = handle(async () => {
    if (updateSupport && !updateSupport.checked)
      throw new Error("原依据已更新，请核对并确认使用当前修订后再送审。");
    if (updateSupport) {
      if (outdated.some((e) => e.state !== "active"))
        throw new Error("更新后的依据仍未可用，请先完成经验补证审查。");
      method.supportRefs = method.supportRefs.map((ref, index) => ({
        ...ref,
        revision: support[index].revision,
      }));
    }
    for (const [index, step] of method.steps.entries()) {
      if (!step.instruction.trim() || !step.supportIndexes.length)
        throw new Error(`请填写步骤 ${index + 1} 的操作并选择依据。`);
      for (const choice of step.choices ?? []) {
        if (!choice.when.text.trim())
          throw new Error(`请填写步骤 ${index + 1} 的分支条件。`);
        if (
          choice.next !== "stop" &&
          method.steps.findIndex((s) => s.stepId === choice.next) <= index
        )
          throw new Error(`步骤 ${index + 1} 的分支需指向后续步骤或结束。`);
      }
    }
    if (!reason.value.trim()) throw new Error("请填写修改说明。");
    const result = await rpc("revisePlaybook", {
      id: latest.id,
      expectedRevision: latest.revision,
      body: {
        title: title.value,
        goal: goal.value,
        topics: topics.value
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean),
        conditions: editConditions(conditions, method.conditions),
        exceptions: editConditions(exceptions, method.exceptions),
        applicability:
          conditions.value.trim() || exceptions.value.trim()
            ? "conditional"
            : "general",
        steps: method.steps,
        completionChecks: method.completionChecks,
        stopConditions: method.stopConditions,
        supportRefs: method.supportRefs,
        change: { ...method.change, kind: "correction", summary: reason.value },
      },
    });
    await show(latest.id);
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
}
async function preparePlaybook(parent) {
  const method = structuredClone(current);
  const panel = node("section", "");
  panel.append(
    node("h3", "关联宿主任务"),
    node(
      "p",
      "选择正在进行的宿主任务，获取完整方法。Agent 在工作中核实条件并选择分支。",
    ),
  );
  parent.append(panel);
  const tasks = (await rpc("listTasks", { scopeId: method.scopeId })).filter(
    (t) => !t.ended,
  );
  if (!tasks.length) {
    panel.append(
      node(
        "p",
        "这个范围内暂无进行中的宿主任务。可以先复制上方方法引用，带回宿主任务使用。",
      ),
    );
    return;
  }
  const task = selectField(
    panel,
    "宿主任务",
    tasks.map((t) => [
      t.taskRef,
      `${t.callerId} · ${new Date(t.createdAt).toLocaleString()} · ${t.taskRef}`,
    ]),
  );
  const output = node("div", "");
  let use,
    preparationRequest = 0;
  task.onchange = () => {
    preparationRequest++;
    use = undefined;
    output.replaceChildren();
  };
  const prepare = async (viewMode = "auto") => {
    const taskRef = task.value,
      request = ++preparationRequest;
    const result = await rpc("preparePlaybook", {
      playbookId: method.id,
      revision: method.revision,
      taskRef,
      viewMode,
      requestId: crypto.randomUUID(),
    });
    if (request !== preparationRequest || task.value !== taskRef) return;
    use = result.playbookUseRef;
    output.replaceChildren(node("h4", "本次任务的方法"));
    if (result.status === "guidance") {
      output.append(
        node(
          "p",
          "先核实适用条件，再按实际结果选择分支。只执行所选路径，并检查本次实际结果。",
        ),
      );
      for (const [key, label] of [
        ["conditions", "适用条件"],
        ["exceptions", "例外"],
      ])
        (result[key] ?? []).forEach((c) =>
          output.append(node("p", label + "：" + c.text)),
        );
      const steps = node("ol", "");
      result.steps.forEach((s) => {
        const item = node("li", s.stepId + "：" + s.instruction);
        (s.choices ?? []).forEach((c) =>
          item.append(
            node(
              "p",
              c.when.text + " → " + (c.next === "stop" ? "停止" : c.next),
            ),
          ),
        );
        steps.append(item);
      });
      output.append(steps);
      for (const [key, label] of [
        ["completionChecks", "完成检查"],
        ["stopConditions", "停止条件"],
      ])
        (result[key] ?? []).forEach((c) =>
          output.append(
            node(
              "p",
              label +
                "（" +
                (c.stepIds?.join("、") ?? "全局") +
                "）：" +
                c.text,
            ),
          ),
        );
    } else if (result.status === "requires_expansion") {
      const expand = node("button", "展开完整方法");
      expand.onclick = handle(() => prepare("expanded"));
      output.append(
        node("p", "完整方法超出默认显示长度，请展开查看。"),
        expand,
      );
    } else
      output.append(
        node(
          "p",
          "准备结果：" +
            result.status +
            (result.reason ? " · " + result.reason : ""),
        ),
      );
    if (use) {
      const reference = field(
        output,
        "带回宿主的任务引用",
        JSON.stringify({
          taskRef,
          playbookId: method.id,
          revision: method.revision,
          playbookUseRef: use,
        }),
      );
      reference.readOnly = true;
      reference.onclick = () => reference.select();
      const rate = node("button", "评价这次使用");
      const playbookUseRef = use;
      rate.onclick = handle(() => rateUseForm(output, taskRef, playbookUseRef));
      output.append(rate);
    }
  };
  const refresh = node("button", "获取完整方法");
  refresh.onclick = handle(() => prepare());
  panel.append(refresh, output);
}
function feedbackForm(parent, kind, value, refresh) {
  const target = { kind, id: value.id, revision: value.revision },
    panel = node("section", "");
  panel.append(node("h3", "评价与纠正"));
  const rating = selectField(panel, "评价", [
    ["helpful", "有帮助"],
    ["irrelevant", "不适用"],
    ["incorrect", "有错误，需要纠正"],
  ]);
  const correction = field(panel, "说明或建议修订的内容", "", true);
  panel.append(
    node("p", "报告错误会暂停当前内容。补充证据并通过审查后，新内容才可使用。"),
  );
  const save = node("button", "提交评价");
  save.onclick = handle(async () => {
    if (rating.value === "incorrect" && !correction.value.trim())
      throw new Error("请说明哪里有误、应如何修订。");
    await rpc("feedback", {
      target,
      rating: rating.value,
      ...(correction.value.trim()
        ? { correctionText: correction.value.trim() }
        : {}),
    });
    await refresh();
    $("notice").textContent =
      rating.value === "incorrect"
        ? "纠正已记录，当前内容等待补证审查。"
        : "评价已记录。";
  });
  panel.append(save);
  parent.append(panel);
}
function rateUseForm(parent, taskRef, playbookUseRef) {
  const panel = node("section", "");
  panel.append(node("h3", "评价这次使用"));
  const rating = selectField(panel, "实际感受", [
      ["helpful", "有帮助"],
      ["irrelevant", "不适用"],
      ["incorrect", "指导有误"],
    ]),
    text = field(panel, "说明（可选）", "", true);
  const save = node("button", "保存评价");
  save.onclick = handle(async () => {
    const receipt = await rpc("ratePlaybookUse", {
      taskRef,
      playbookUseRef,
      rating: rating.value,
      ...(text.value.trim() ? { text: text.value.trim() } : {}),
    });
    const rejected = receipt.results?.find(
      (result) => !["accepted", "duplicate"].includes(result.status),
    );
    if (rejected)
      throw new Error(`评价未保存：${rejected.reason ?? rejected.status}`);
    panel.replaceChildren(node("p", "这次使用的评价已记录。"));
  });
  panel.append(save);
  parent.append(panel);
}
function jobControls(parent, receipt, refresh) {
  const panel = node("section", ""),
    status = node("pre", `已接收，作业 ${receipt.jobId}`);
  let jobId = receipt.jobId;
  const check = node("button", "查询复盘结果"),
    cancel = node("button", "取消作业"),
    retry = node("button", "重试");
  retry.hidden = true;
  const read = async () => {
    const job = await rpc("getJob", { id: jobId });
    status.textContent = JSON.stringify(job, null, 2);
    cancel.disabled = ["completed", "failed", "canceled"].includes(job.status);
    retry.hidden = !["failed", "canceled"].includes(job.status);
    if (job.status === "completed") {
      const reload = node("button", "查看最新内容");
      reload.onclick = handle(refresh);
      if (!panel.querySelector("[data-reload]")) {
        reload.dataset.reload = "true";
        panel.append(reload);
      }
    }
  };
  check.onclick = handle(read);
  cancel.onclick = handle(async () => {
    await rpc("cancelJob", { id: jobId });
    await read();
  });
  retry.onclick = handle(async () => {
    const next = await rpc("retryJob", { id: jobId });
    jobId = next.jobId;
    await read();
  });
  panel.append(status, check, cancel, retry);
  parent.append(panel);
}
function supplementExperience(parent, experience) {
  const panel = node("section", "");
  panel.append(
    node("h3", "补充核实依据"),
    node(
      "p",
      experience.review?.question ??
        "补充可核对的观察，说明这条经验如何得到验证。",
    ),
  );
  const evidence = field(panel, "实际原文或观察", "", true),
    send = node("button", "提交补证");
  send.onclick = handle(async () => {
    if (!evidence.value.trim()) throw new Error("请填写可核对的原文或观察。");
    const receipt = await rpc("submitSource", {
      scopeId: experience.scopeId,
      verificationFor: {
        kind: "experience",
        id: experience.id,
        revision: experience.revision,
      },
      segments: [{ text: evidence.value.trim(), role: "user" }],
    });
    send.disabled = true;
    jobControls(panel, receipt, () => showRecord("experience", experience.id));
  });
  panel.append(send);
  parent.append(panel);
}
function resetRecordStates() {
  const states = ["active", "held", "disabled"];
  $("record-state").replaceChildren(node("option", "全部状态"));
  $("record-state").firstChild.value = "";
  for (const state of states) {
    const option = node("option", labels[state]);
    option.value = state;
    $("record-state").append(option);
  }
}
$("record-search").onsubmit = handle(async (event) => {
  event.preventDefault();
  recordPage = 0;
  await renderRecords();
});
async function renderRecords() {
  const kind = "experience",
    query = $("record-query").value.trim().toLowerCase(),
    scope = $("record-scope").value,
    state = $("record-state").value;
  const rows = (await rpc("browseExperiences"))
    .filter(
      (row) =>
        (!scope || row.scopeId === scope) &&
        (!state || (row.state ?? row.result?.status) === state) &&
        (!query || JSON.stringify(row).toLowerCase().includes(query)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  recordPage = Math.min(
    recordPage,
    Math.max(0, Math.ceil(rows.length / pageSize) - 1),
  );
  $("record-cards").replaceChildren();
  for (const row of rows.slice(
    recordPage * pageSize,
    (recordPage + 1) * pageSize,
  )) {
    const card = node("section", "");
    card.className = "card";
    card.tabIndex = 0;
    card.append(
      node("h2", row.topic ?? row.conclusion),
      node(
        "p",
        `${row.scopeId} · ${labels[row.state ?? row.result?.status]} · 修订 ${row.revision}`,
      ),
    );
    card.onclick = handle(() => showRecord(kind, row.id));
    card.onkeydown = (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        card.click();
      }
    };
    $("record-cards").append(card);
  }
  if (!rows.length) $("record-cards").append(node("p", "暂无符合条件的内容。"));
  const previous = node("button", "上一页"),
    next = node("button", "下一页");
  previous.disabled = recordPage === 0;
  next.disabled = (recordPage + 1) * pageSize >= rows.length;
  previous.onclick = handle(async () => {
    recordPage--;
    await renderRecords();
  });
  next.onclick = handle(async () => {
    recordPage++;
    await renderRecords();
  });
  $("record-pages").replaceChildren(
    previous,
    node("span", `第 ${recordPage + 1} 页 · 共 ${rows.length} 项`),
    next,
  );
}
async function showRecord(kind, id) {
  const value = await rpc("inspectExperience", { id }),
    d = $("record-detail");
  d.replaceChildren(
    node("h2", value.topic ?? value.conclusion),
    node("p", `${value.scopeId} · 修订 ${value.revision}`),
  );
  const reference = field(
    d,
    "内容引用",
    JSON.stringify({ kind, id, revision: value.revision }),
  );
  reference.readOnly = true;
  reference.onclick = () => reference.select();
  {
    d.append(
      node(
        "p",
        `${value.level} · ${labels[value.state]} · ${value.assessment}`,
      ),
    );
    for (const [key, title] of [
      ["conditions", "适用条件"],
      ["exceptions", "例外"],
    ])
      if (value[key].length)
        d.append(
          node("h3", title),
          ...value[key].map((item) => node("p", item.text)),
        );
    if (value.review)
      d.append(
        node("h3", "待核实问题"),
        node("p", value.review.question),
        node(
          "p",
          `核实期限：${new Date(value.review.reviewBy).toLocaleString()}`,
        ),
      );
    const feedback = node("button", "评价或提交修订意见");
    feedback.onclick = handle(() =>
      feedbackForm(d, kind, value, () => showRecord(kind, id)),
    );
    d.append(feedback);
    if (value.state === "held") {
      const supplement = node("button", "补充证据并审查");
      supplement.onclick = () => supplementExperience(d, value);
      d.append(supplement);
    }
    const state = node(
      "button",
      value.state === "disabled" ? "重新启用" : "停用经验",
    );
    state.onclick = handle(async () => {
      await rpc("setExperienceState", {
        id,
        expectedRevision: value.revision,
        state: value.state === "disabled" ? "active" : "disabled",
      });
      await showRecord(kind, id);
      await renderRecords();
    });
    d.append(state);
  }
  addWorkView(d, { kind: "experience", id });
  d.append(node("h3", "原文依据"));
  for (const evidence of value.evidence)
    d.append(node("blockquote", `[${evidence.role}] ${evidence.excerpt}`));
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
    if (source.segment) card.append(node("blockquote", source.segment.text));
    else
      card.append(
        node(
          "p",
          source.contentStatus === "erased" ? "原文已擦除" : "原文保留期已结束",
        ),
      );
    addWorkView(card, { kind: "source", id: source.id });
    if (!source.blocked && !source.erased) {
      const append = node("button", "补充结果或后续观察");
      append.onclick = () => supplementSource(card, source);
      card.append(append);
    }
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
      const interval = field(
        card,
        "自动同步间隔（分钟，0 为手动）",
        String(connection.intervalMinutes ?? 0),
      );
      interval.type = "number";
      interval.min = "0";
      interval.max = "1440";
      const saveSchedule = node("button", "保存同步间隔");
      saveSchedule.onclick = handle(async () => {
        await rpc("connector.schedule", {
          id: connection.id,
          expectedRevision: connection.revision,
          intervalMinutes: Number(interval.value),
        });
        await renderConnections();
      });
      card.append(saveSchedule);
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
  const r = await rpc("submitSource", {
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
    review.playbooks.forEach((m) =>
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

async function issueForm(parent, caseData) {
  const panel = node("section", "");
  panel.append(
    node("p", "选择实际事件作为依据。确认问题不会自动修改或修复方法。"),
  );
  const existing = (await rpc("reviews.issues")).filter(
    (i) => i.scopeId === caseData.scopeId,
  );
  const target = node("select", "");
  target.setAttribute("aria-label", "新建或关联问题");
  target.append(node("option", "新建问题"));
  for (const issue of existing) {
    const option = node(
      "option",
      issue.category +
        " · " +
        issue.status +
        " · 涉及任务 " +
        issue.affectedTasks,
    );
    option.value = issue.id;
    target.append(option);
  }
  panel.append(target);
  const key = field(panel, "新问题名称", ""),
    category = node("select", "");
  category.setAttribute("aria-label", "问题类型");
  for (const [value, label] of [
    ["stale_method", "过期方法"],
    ["wrong_scope", "范围错误"],
    ["wrong_branch", "分支错误"],
    ["incorrect_guidance", "指导错误"],
  ]) {
    const option = node("option", label);
    option.value = value;
    category.append(option);
  }
  panel.append(category);
  const evidence = node("select", "");
  evidence.setAttribute("aria-label", "问题依据");
  caseData.events.forEach((e) => {
    const o = node("option", e.text);
    o.value = e.eventId;
    evidence.append(o);
  });
  panel.append(evidence);
  const confirmed = field(panel, "已核对，确认问题存在", ""),
    serious = field(panel, "严重问题，需要及时处理", "");
  confirmed.type = "checkbox";
  serious.type = "checkbox";
  target.onchange = () => {
    const old = existing.find((i) => i.id === target.value);
    confirmed.checked = old?.status === "confirmed";
    serious.checked = old?.severity === "serious";
    if (old) category.value = old.category;
  };
  const save = node("button", "保存复核");
  save.onclick = handle(async () => {
    const old = existing.find((i) => i.id === target.value);
    await rpc("reviews.issue", {
      scopeId: caseData.scopeId,
      ...(old ? { id: old.id } : { problemKey: key.value }),
      expectedRevision: old?.revision ?? 0,
      category: old?.category ?? category.value,
      status: old?.status ?? (confirmed.checked ? "confirmed" : "suspected"),
      severity: old?.severity ?? (serious.checked ? "serious" : "normal"),
      evidence: [{ caseId: caseData.id, eventId: evidence.value }],
    });
    panel.remove();
    await renderIssues();
    await renderReviewNotifications();
  });
  panel.append(save);
  parent.append(panel);
}
async function renderIssues() {
  const container = $("review-issues");
  container.replaceChildren();
  for (const issue of await rpc("reviews.issues")) {
    const card = node("section", "");
    card.className = "card";
    card.append(
      node("h3", issue.category),
      node(
        "p",
        issue.status +
          " · " +
          issue.severity +
          " · 涉及任务 " +
          issue.affectedTasks,
      ),
    );
    const confirm = node("button", "确认为严重问题"),
      resolve = node("button", "标为已解决");
    const update = async (status, severity) => {
      await rpc("reviews.issue", {
        scopeId: issue.scopeId,
        id: issue.id,
        expectedRevision: issue.revision,
        reconfirm: status === "confirmed",
        category: issue.category,
        status,
        severity,
        evidence: issue.evidence,
      });
      await renderIssues();
      await renderReviewNotifications();
    };
    confirm.onclick = handle(() => update("confirmed", "serious"));
    resolve.onclick = handle(() => update("resolved", issue.severity));
    card.append(confirm, resolve);
    container.append(card);
  }
}

function exportCaseForm(parent, caseData) {
  const panel = node("section", "");
  panel.append(
    node(
      "p",
      "先预览并脱敏。导出只有保留的事件和可选工具观察，不包含完整初始工作区。",
    ),
  );
  const terms = field(panel, "需要替换的文字（每行一项）", "", true),
    observations = field(panel, "包含仍保留的工具观察", "");
  observations.type = "checkbox";
  const preview = node("button", "生成预览"),
    output = node("pre", "");
  let download;
  const invalidate = () => {
    download?.remove();
    download = undefined;
    output.textContent = "预览条件已变化，请重新生成。";
  };
  terms.oninput = invalidate;
  observations.onchange = invalidate;
  preview.onclick = handle(async () => {
    download?.remove();
    const input = {
      caseIds: [caseData.id],
      includeObservations: observations.checked,
      redact: terms.value.split("\n").filter(Boolean),
    };
    const result = await rpc("reviews.export", input);
    output.textContent = result.content;
    download = node("button", "下载已预览样本");
    download.onclick = handle(async () => {
      const fresh = await rpc("reviews.export", input);
      if (fresh.contentRevision !== result.contentRevision) {
        invalidate();
        throw new Error("来源已变化，请重新预览后下载。");
      }
      const url = URL.createObjectURL(
        new Blob([fresh.content], { type: "application/json;charset=utf-8" }),
      );
      const link = node("a", "");
      link.href = url;
      link.download = fresh.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    panel.append(download);
  });
  panel.append(preview, output);
  parent.append(panel);
}

function addWorkView(parent, target) {
  const button = node("button", "查看相关工作记录");
  button.onclick = handle(async () => {
    const view = await rpc("getWorkView", target);
    const panel = node("section", "");
    panel.append(node("h3", "相关工作记录"));
    if (!view.items.length) panel.append(node("p", "暂无保留的工作记录。"));
    for (const item of view.items) {
      panel.append(node("h4", item.topic), node("p", item.goal));
      for (const attempt of item.attempts)
        panel.append(node("p", attempt.action), node("p", attempt.observation));
      panel.append(node("p", item.result.summary));
      for (const evidence of item.evidence)
        panel.append(node("blockquote", evidence.excerpt));
      for (const source of item.sources) {
        const open = node("button", "查看来源 " + source.id.slice(0, 8));
        open.onclick = handle(async () => {
          const value = await rpc("inspectSource", { id: source.id });
          panel.append(node("blockquote", value.segment?.text ?? "原文已清理"));
          if (!value.blocked && !value.erased) supplementSource(panel, value);
        });
        panel.append(open);
      }
    }
    parent.append(panel);
    button.disabled = true;
  });
  parent.append(button);
}
function supplementSource(parent, source) {
  const panel = node("section", "");
  const text = field(panel, "实际结果、尝试及可核对的依据", "", true);
  const send = node("button", "提交结果复盘");
  send.onclick = handle(async () => {
    if (!text.value.trim()) throw new Error("请填写实际结果和依据。");
    const receipt = await rpc("submitSource", {
      scopeId: source.scopeId,
      sourceFor: { id: source.id, revision: source.revision },
      segments: [{ role: "user", text: text.value.trim() }],
    });
    send.disabled = true;
    jobControls(panel, receipt, renderSources);
  });
  panel.append(send);
  parent.append(panel);
}
