/* 透明图层叠序校准台 —— 前端逻辑（原生 JS） */
"use strict";

const MIN_LAYERS = 2, MAX_LAYERS = 7;
const MIN_SAMPLES = 1, MAX_SAMPLES = 4;
const MAX_RELATIONS = 12;

const state = {
  layers: [
    { id: "R", color: "#ff0000", opacity: 0.5 },
    { id: "B", color: "#0000ff", opacity: 0.5 },
  ],
  samples: [
    { background: "#ffffff", target: "#e189bc" },
    { background: "#000000", target: "#bc0089" },
  ],
  relations: [], // {lower, upper}
};

let solveTimer = null;
let lastErrorKey = "";
let inflightToken = 0;

const $ = (sel) => document.querySelector(sel);
const elLayers = $("#layers");
const elSamples = $("#samples");
const elRelations = $("#relations");
const elErrorBanner = $("#errorBanner");
const elErrorList = $("#errorList");
const elResultBody = $("#resultBody");
const elStatus = $("#status");

// ------------------------------------------------------------ 工具函数 --

function normalizeHex(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = "#" + s[1].repeat(2) + s[2].repeat(2) + s[3].repeat(2);
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function scheduleSolve(delay = 200) {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, delay);
  markInferStaleness();
}

// ------------------------------------------------------------ 渲染输入 --

function render() {
  renderLayers();
  renderSamples();
  renderRelations();
  $("#addLayerBtn").disabled = state.layers.length >= MAX_LAYERS;
  $("#addSampleBtn").disabled = state.samples.length >= MAX_SAMPLES;
  $("#addRelationBtn").disabled = state.relations.length >= MAX_RELATIONS;
}

function renderLayers() {
  elLayers.innerHTML = "";
  const idCounts = {};
  state.layers.forEach((l) => {
    const k = l.id.trim();
    if (k) idCounts[k] = (idCounts[k] || 0) + 1;
  });
  const duplicateIds = new Set(
    Object.entries(idCounts).filter(([, n]) => n > 1).map(([k]) => k)
  );
  state.layers.forEach((layer, i) => {
    const validHex = normalizeHex(layer.color);
    const opNum = typeof layer.opacity === "number" ? layer.opacity : NaN;
    const opValid = Number.isFinite(opNum) && opNum >= 0 && opNum <= 1;
    const opValue = opValid ? opNum : "";
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input class="id-input ${layer.id && duplicateIds.has(layer.id) ? "invalid" : ""}"
             data-act="layer-id" data-i="${i}" type="text"
             value="${escapeHtml(layer.id)}" placeholder="ID" />
      <input type="color" data-act="layer-picker" data-i="${i}"
             value="${validHex || "#000000"}" title="选色" />
      <input class="hex-input ${validHex ? "" : "invalid"}" data-act="layer-hex" data-i="${i}"
             type="text" value="${escapeHtml(layer.color)}" placeholder="#RRGGBB" />
      <input class="opacity-range" data-act="layer-opacity-range" data-i="${i}"
             type="range" min="0" max="1" step="0.01" value="${opValid ? opNum : 1}" />
      <input class="opacity-input ${opValid ? "" : "invalid"}" data-act="layer-opacity"
             data-i="${i}" type="number" min="0" max="1" step="0.01"
             value="${opValue}" />
      <span class="opacity-val">${opValid ? Math.round(opNum * 100) + "%" : "—"}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-layer" data-i="${i}"
              type="button" ${state.layers.length <= MIN_LAYERS ? "disabled" : ""}>删除</button>
    `;
    elLayers.appendChild(row);
  });
}

function renderSamples() {
  elSamples.innerHTML = "";
  state.samples.forEach((smp, i) => {
    const bg = normalizeHex(smp.background);
    const tg = normalizeHex(smp.target);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <span class="field-label">背景
        <input type="color" data-act="sample-bg-picker" data-i="${i}"
               value="${bg || "#000000"}" />
        <input class="hex-input" data-act="sample-bg" data-i="${i}" type="text"
               value="${escapeHtml(smp.background)}" placeholder="#RRGGBB" />
      </span>
      <span class="field-label">目标
        <input type="color" data-act="sample-target-picker" data-i="${i}"
               value="${tg || "#000000"}" />
        <input class="hex-input" data-act="sample-target" data-i="${i}" type="text"
               value="${escapeHtml(smp.target)}" placeholder="#RRGGBB" />
      </span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-sample" data-i="${i}"
              type="button" ${state.samples.length <= MIN_SAMPLES ? "disabled" : ""}>删除</button>
    `;
    elSamples.appendChild(row);
  });
}

function renderRelations() {
  elRelations.innerHTML = "";
  if (state.relations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "暂无约束（任意图层顺序均可参与择优）。";
    elRelations.appendChild(empty);
    return;
  }
  const options = state.layers
    .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.id)}</option>`)
    .join("");
  state.relations.forEach((rel, i) => {
    const row = document.createElement("div");
    row.className = "relation-row";
    row.innerHTML = `
      <select data-act="rel-lower" data-i="${i}">
        ${optionWith(options, rel.lower)}
      </select>
      <span class="relation-arrow">在更下方 ▲ 叠在</span>
      <select data-act="rel-upper" data-i="${i}">
        ${optionWith(options, rel.upper)}
      </select>
      <span class="relation-arrow">之上</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-relation" data-i="${i}"
              type="button">删除</button>
    `;
    elRelations.appendChild(row);
  });
}

// select 选项无法靠内部标记 selected，重写一份带 selected 的
function optionWith(allOptions, selectedId) {
  if (!state.layers.some((l) => l.id === selectedId)) {
    return `<option value="" selected>（请选择）</option>${allOptions}`;
  }
  return state.layers
    .map(
      (l) =>
        `<option value="${escapeHtml(l.id)}"${l.id === selectedId ? " selected" : ""}>${escapeHtml(
          l.id
        )}</option>`
    )
    .join("");
}

// ------------------------------------------------------------ 事件代理 --

document.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (!act) return;
  const i = Number(t.dataset.i);

  switch (act) {
    case "layer-id":
      state.layers[i].id = t.value;
      renderRelationsKeepFocus(t);
      scheduleSolve();
      break;
    case "layer-hex":
      state.layers[i].color = t.value;
      syncPicker(t, "layer-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    case "layer-picker":
      state.layers[i].color = t.value.toLowerCase();
      syncTextInput("layer-hex", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "layer-opacity": {
      const v = parseFloat(t.value);
      state.layers[i].opacity = Number.isNaN(v) ? t.value : v;
      if (typeof state.layers[i].opacity === "number" &&
          state.layers[i].opacity >= 0 && state.layers[i].opacity <= 1) {
        syncRange(i, state.layers[i].opacity);
      }
      scheduleSolve();
      break;
    }
    case "layer-opacity-range":
      state.layers[i].opacity = parseFloat(t.value);
      syncNumberInput(i, state.layers[i].opacity);
      scheduleSolve();
      break;
    case "sample-bg":
    case "sample-target": {
      const key = act === "sample-bg" ? "background" : "target";
      state.samples[i][key] = t.value;
      syncPicker(t, act + "-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    }
    case "sample-bg-picker":
      state.samples[i].background = t.value.toLowerCase();
      syncTextInput("sample-bg", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "sample-target-picker":
      state.samples[i].target = t.value.toLowerCase();
      syncTextInput("sample-target", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "rel-lower":
      state.relations[i].lower = t.value;
      scheduleSolve();
      break;
    case "rel-upper":
      state.relations[i].upper = t.value;
      scheduleSolve();
      break;
  }
});

function syncPicker(textEl, pickerAct, i, raw) {
  const hx = normalizeHex(raw);
  const picker = document.querySelector(`input[data-act="${pickerAct}"][data-i="${i}"]`);
  if (picker && hx) picker.value = hx;
}
function syncTextInput(act, i, value) {
  const el = document.querySelector(`input[data-act="${act}"][data-i="${i}"]`);
  if (el && el.value !== value) {
    el.value = value;
    el.classList.remove("invalid");
  }
}
function syncRange(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity-range"][data-i="${i}"]`);
  if (el) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}
function syncNumberInput(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity"][data-i="${i}"]`);
  if (el && parseFloat(el.value) !== value) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}

// ID 文本框输入时只重建关系下拉，避免打断图层区输入焦点
function renderRelationsKeepFocus(activeEl) {
  const activeStart = activeEl.selectionStart;
  const activeEnd = activeEl.selectionEnd;
  renderRelations();
  activeEl.focus();
  try {
    activeEl.setSelectionRange(activeStart, activeEnd);
  } catch (_) { /* ignore */ }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.i);

  if (act === "add-layer" && state.layers.length < MAX_LAYERS) {
    state.layers.push({ id: uniqueId("L"), color: "#808080", opacity: 0.5 });
    render();
    scheduleSolve(0);
  } else if (act === "remove-layer" && state.layers.length > MIN_LAYERS) {
    const removed = state.layers[i].id.trim();
    state.layers.splice(i, 1);
    state.relations = state.relations.filter(
      (r) => r.lower.trim() !== removed && r.upper.trim() !== removed
    );
    render();
    scheduleSolve(0);
  } else if (act === "add-sample" && state.samples.length < MAX_SAMPLES) {
    state.samples.push({ background: "#ffffff", target: "#ffffff" });
    render();
    scheduleSolve(0);
  } else if (act === "remove-sample" && state.samples.length > MIN_SAMPLES) {
    state.samples.splice(i, 1);
    render();
    scheduleSolve(0);
  } else if (act === "add-relation" && state.relations.length < MAX_RELATIONS) {
    const first = state.layers[0]?.id || "";
    const second = state.layers[1]?.id || first;
    state.relations.push({ lower: first, upper: second });
    render();
    scheduleSolve(0);
  } else if (act === "remove-relation") {
    state.relations.splice(i, 1);
    render();
    scheduleSolve(0);
  }
});

let idCounter = 0;
function uniqueId(prefix) {
  let candidate;
  do {
    idCounter += 1;
    candidate = `${prefix}${idCounter}`;
  } while (state.layers.some((l) => l.id === candidate));
  return candidate;
}

// ------------------------------------------------------------ 调用后端 --

async function runSolve() {
  const payload = {
    layers: state.layers.map((l) => ({
      id: l.id,
      color: l.color,
      opacity: l.opacity,
    })),
    samples: state.samples.map((s) => ({
      background: s.background,
      target: s.target,
    })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
  };

  const token = ++inflightToken;
  elStatus.textContent = "计算中…";
  elStatus.className = "status busy";

  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (token !== inflightToken) return; // 已有更新的请求，丢弃旧结果
    const data = await resp.json();
    if (!resp.ok) {
      showErrors(data.errors || [{ scope: "form", message: "求解失败" }]);
    } else {
      showErrors([]);
      renderResult(data);
    }
  } catch (err) {
    if (token !== inflightToken) return;
    showErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showErrors(errors) {
  const key = JSON.stringify(errors);
  if (key === lastErrorKey) {
    // 内容不变时只更新状态文字，不重绘
    if (errors.length) {
      elStatus.textContent = "存在输入错误";
      elStatus.className = "status";
    }
    return;
  }
  lastErrorKey = key;

  if (!errors.length) {
    elErrorBanner.hidden = true;
    elErrorList.innerHTML = "";
    return;
  }
  elErrorList.innerHTML = errors
    .map((er) => `<li>${escapeHtml(er.message)}</li>`)
    .join("");
  elErrorBanner.hidden = false;
  elStatus.textContent = "存在输入错误";
  elStatus.className = "status";
  elResultBody.innerHTML = `<div class="result-empty">修正输入后将自动重新计算。</div>`;
  $("#inferCard").hidden = true;
}

// ------------------------------------------------------------ 结果渲染 --

function renderResult(r) {
  elStatus.textContent = "";
  elStatus.className = "status";

  const chips = r.order
    .map((id, k) => {
      const layer = r.layers[k];
      const rgba = hexToRgba(layer.color, layer.opacity);
      return `
        <span class="chip">
          <span class="dot" style="background:${rgba}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
          <span class="cop">α=${Number(layer.opacity.toFixed(2))}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  const body = `
    <div class="order-panel">
      <div class="order-title">最优叠放顺序（底 → 顶）</div>
      <div class="checker">
        <div class="order-chips">
          <span class="order-ends">底</span>
          ${chips}
          <span class="order-ends">↑ 顶</span>
        </div>
      </div>
      <div class="metric-row">
        <span>总平方误差（未取整 0–255 通道）：<b>${fmtSse(r.totalSse)}</b></span>
        <span>枚举排列：<b>${r.permutationsChecked}</b> 个</span>
        <span>满足约束：<b>${r.feasibleCount}</b> 个</span>
        <span>同分时按 ID 字典序决胜</span>
      </div>
    </div>
    ${r.samples.map(renderSample).join("")}
  `;
  elResultBody.innerHTML = body;
  syncInferPanel(r);
}

function renderSample(s) {
  const targetRgb = s.targetRgb.map((v) => Math.round(v)).join(", ");
  const predRgb = s.predictedRgb.map((v) => Math.round(v)).join(", ");
  const [cr, cg, cb] = s.channelSse;
  const rating =
    s.sse < 1 ? "r-good" : s.sse < 100 ? "r-mid" : "r-bad";
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${s.index + 1}</span>
        <span class="${rating}">SSE = ${fmtSse(s.sse)}</span>
      </div>
      <div class="compare">
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.target}"></span>
          <span class="swatch-meta">
            <div class="name">目标色</div>
            <div class="hexval">${s.target}</div>
            <div class="name">rgb(${targetRgb})</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">预测色</div>
            <div class="hexval">${s.predictedHex}</div>
            <div class="name">rgb(${predRgb})</div>
          </span>
        </div>
      </div>
      <div class="bg-note">
        <span class="mini" style="background:${s.background}"></span>
        在背景 ${s.background} 上叠放
      </div>
      <div class="sse-line">
        <span class="sse-chan">R²误差 ${fmtSse(cr)}</span>
        <span class="sse-chan">G²误差 ${fmtSse(cg)}</span>
        <span class="sse-chan">B²误差 ${fmtSse(cb)}</span>
      </div>
    </div>
  `;
}

function hexToRgba(hex, alpha) {
  const h = normalizeHex(hex) || "#000000";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmtSse(v) {
  if (v === 0) return "0";
  if (v < 0.001) return v.toExponential(3);
  return Number(v.toFixed(4)).toString();
}

// 网格值（0.01 整数倍）显示为两位小数；原始参数组入选时保留必要精度
function fmtOpacity(v) {
  if (Math.abs(v - Math.round(v * 100) / 100) < 1e-9) return Number(v.toFixed(2)).toString();
  return String(v);
}

// ============================================================ 不透明度反推 ==

const inferState = {
  order: [],          // 当前确认顺序（ID 数组）
  picks: new Set(),   // 勾选的待调 ID
  result: null,       // 最近一次成功返回
  resultKey: "",      // 结果产生时的输入指纹
  appliedSig: "",     // 上一次点「应用」之后的输入指纹（与当前一致则结果仍代表现状）
  applied: false,     // 当前结果是否已写回图层
};

let orderSlotBefore = "";

const elInferCard = $("#inferCard");
const elInferOrder = $("#inferOrder");
const elInferPick = $("#inferPick");
const elInferHint = $("#inferHint");
const elInferErrors = $("#inferErrors");
const elInferResult = $("#inferResult");
const elInferStatus = $("#inferStatus");

function inferSignature() {
  // 用于判断已有反推结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    order: inferState.order,
    picks: [...inferState.picks].sort(),
  });
}

function syncInferPanel(solveResult) {
  elInferCard.hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  if (inferState._idSig !== idSig) {
    // 图层集合（ID 列表）变化：重建顺序与勾选，默认采用求解顺序
    inferState._idSig = idSig;
    inferState.order = [...solveResult.order];
    inferState.picks = new Set();
    inferState.result = null;
    inferState.resultKey = "";
    inferState.appliedSig = "";
    inferState.applied = false;
    elInferResult.innerHTML = "";
    elInferErrors.hidden = true;
  } else {
    // 集合未变：把求解新出现、但当前顺序未包含的 ID 补齐（防御性）
    inferState.order = inferState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!inferState.order.includes(id)) inferState.order.push(id);
    });
    inferState.picks = new Set([...inferState.picks].filter((id) => layerSet.has(id)));
  }
  renderInferControls();
  markInferStaleness();
}

function layerById(id) {
  return state.layers.find((l) => l.id === id);
}

function renderInferControls() {
  // ---- 顺序槽 ----
  elInferOrder.innerHTML = "";
  inferState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="infer-order" data-pos="${pos}" title="该位置（底 → 顶第 ${pos + 1} 层）的图层">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elInferOrder.appendChild(slot);
    if (pos < inferState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elInferOrder.appendChild(ar);
    }
  });

  // ---- 待调勾选 ----
  elInferPick.innerHTML = "";
  state.layers.forEach((l) => {
    const hex = normalizeHex(l.color) || "#000000";
    const checked = inferState.picks.has(l.id);
    const disabled = !checked && inferState.picks.size >= 2;
    const label = document.createElement("label");
    label.className = "pick-item" + (disabled ? " disabled" : "");
    label.innerHTML = `
      <input type="checkbox" data-act="infer-pick" data-id="${escapeHtml(l.id)}"
             ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span class="pick-dot" style="background:${hexToRgba(hex, l.opacity)}"></span>
      <span>${escapeHtml(l.id)}</span>
    `;
    elInferPick.appendChild(label);
  });

  updateInferRunHint();
  markInferStaleness();
}

function updateInferRunHint() {
  const btn = $("#inferRunBtn");
  const n = inferState.picks.size;
  btn.disabled = n < 1 || n > 2;
  elInferHint.textContent =
    n === 0 ? "请勾选 1～2 个待调图层" : `已选 ${n} 个，将在 0.00～1.00（步长 0.01）网格上联合反推`;
}

function markInferStaleness() {
  if (!inferState.result) return;
  const sig = inferSignature();
  // 结果产生时、或上次应用建议值之后的状态，都视为与当前结果一致
  const fresh = sig === inferState.resultKey || sig === inferState.appliedSig;
  inferState.applied = inferState.applied && fresh;
  const old = elInferResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入或选择已变化，以下结果可能过期，请重新反推。";
    elInferResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

// 结果是否仍代表当前输入；false 时「应用」按钮应可重新点击
function inferResultFresh() {
  if (!inferState.result) return false;
  const sig = inferSignature();
  return sig === inferState.resultKey || sig === inferState.appliedSig;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "infer-order") {
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证顺序始终是全部图层的一个排列
    const other = inferState.order.findIndex((id, p) => p !== pos && id === t.value);
    inferState.order[pos] = t.value;
    if (other !== -1 && prev) inferState.order[other] = prev;
    renderInferControls();
  } else if (act === "infer-pick") {
    const id = t.dataset.id;
    if (t.checked) inferState.picks.add(id);
    else inferState.picks.delete(id);
    renderInferControls();
  }
});

// select change 前记录原值，供交换使用
document.addEventListener("focusin", (e) => {
  if (e.target.dataset && e.target.dataset.act === "infer-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = inferState.order[pos];
  }
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "infer-run") runInfer();
  if (btn.dataset.act === "infer-apply") applyInferResult();
});

async function runInfer() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    order: inferState.order,
    adjustIds: [...inferState.picks].sort(),
  };
  elInferStatus.textContent = "反推中…";
  elInferStatus.className = "status busy";
  elInferErrors.hidden = true;

  try {
    const resp = await fetch("/api/infer-opacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    if (!resp.ok) {
      showInferErrors(data.errors || [{ scope: "form", message: "反推失败" }]);
      return;
    }
    inferState.result = data;
    inferState.resultKey = inferSignature();
    inferState.applied = false;
    renderInferResult(data);
  } catch (err) {
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    showInferErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showInferErrors(errors) {
  elInferErrors.innerHTML =
    '<ul>' + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elInferErrors.hidden = false;
}

function renderInferResult(r) {
  const delta = r.afterTotalSse - r.beforeTotalSse;
  const deltaCls = delta < -1e-9 ? "sse-delta-down" : delta > 1e-9 ? "sse-delta-up" : "";
  const deltaTxt =
    Math.abs(delta) < 1e-9 ? "持平" : `${delta > 0 ? "+" : "−"}${fmtSse(Math.abs(delta))}`;

  const rows = r.adjustments
    .map((a) => {
      const changed =
        Math.abs(a.originalOpacity - a.suggestedOpacity) > 1e-9;
      return `
        <tr>
          <td>${escapeHtml(a.id)}</td>
          <td class="num">${fmtOpacity(a.originalOpacity)}</td>
          <td class="op-arrow">→</td>
          <td class="num ${changed ? "op-new" : "op-same"}">
            ${fmtOpacity(a.suggestedOpacity)}${changed ? "" : "（原值即最优）"}
          </td>
        </tr>`;
    })
    .join("");

  const samples = r.afterSamples
    .map((s, k) => renderInferSample(s, r.beforeSamples[k]))
    .join("");

  const applied = inferResultFresh() && inferState.applied;
  elInferResult.innerHTML = `
    <table class="adj-table">
      <thead><tr><th>待调图层</th><th>原不透明度</th><th></th><th>建议不透明度</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sse-compare">
      <span>调整前总误差：<b>${fmtSse(r.beforeTotalSse)}</b></span>
      <span class="after">调整后总误差：<b>${fmtSse(r.afterTotalSse)}</b></span>
      <span class="${deltaCls}">变化：<b>${deltaTxt}</b></span>
      <span>评估组合：<b>${r.combosChecked}</b> 组（含原始参数组）</span>
    </div>
    ${samples}
    <div class="infer-apply-row">
      <button class="btn btn-small" data-act="infer-apply" type="button"
              ${applied ? "disabled" : ""}>应用建议值回图层并重新求解</button>
      ${applied ? '<span class="applied-note">已应用，左侧图层与上方校准结果已更新。</span>' : ""}
    </div>
  `;
}

function renderInferSample(after, before) {
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${after.index + 1}</span>
        <span class="hint">背景 ${after.background}</span>
      </div>
      <div class="tri-compare">
        ${triCell("目标色", after.target, after.targetRgb, null)}
        <span class="tri-arrow">→</span>
        ${triCell("调整前预测", before.predictedHex, before.predictedRgb, before.sse)}
        <span class="tri-arrow">→</span>
        ${triCell("调整后预测", after.predictedHex, after.predictedRgb, after.sse)}
      </div>
    </div>
  `;
}

function triCell(tag, hex, rgb, sse) {
  const rgbTxt = rgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="tri-cell">
      <div class="cell-tag">
        <span>${tag}</span>
        ${sse == null ? "" : `<span class="tag-sse">SSE ${fmtSse(sse)}</span>`}
      </div>
      <div class="tri-swatch">
        <span class="swatch-big" style="background:${hex}"></span>
        <span>
          <div class="hexval">${hex}</div>
          <div class="name">rgb(${rgbTxt})</div>
        </span>
      </div>
    </div>
  `;
}

function applyInferResult() {
  const r = inferState.result;
  if (!r) return;
  r.adjustments.forEach((a) => {
    const layer = state.layers.find((l) => l.id === a.id);
    if (layer) layer.opacity = a.suggestedOpacity;
  });
  // 记录应用后的状态指纹：在再次改动输入前，结果始终代表当前图层
  inferState.applied = true;
  inferState.appliedSig = inferSignature();
  renderInferResult(inferState.result);
  render();
  runSolve();
}

// ------------------------------------------------------------ 启动 --
render();
runSolve();
