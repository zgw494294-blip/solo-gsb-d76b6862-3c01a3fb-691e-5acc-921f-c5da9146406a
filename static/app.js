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

/* 不透明度反推：沿用最近一次求解结果，顺序与待调图层由用户在结果栏确认 */
const infer = {
  order: [],          // 底 → 顶的图层 ID 序列（初始同步自求解结果）
  tuneIds: [],        // 待调图层 ID（至多 2 个）
  result: null,       // 最近一次反推结果
  fingerprint: "",    // 结果对应的输入指纹，输入变动即作废
  busy: false,
  error: null,        // 反推卡片自身的错误（{errors:[...]} 或字符串）
};

const $ = (sel) => document.querySelector(sel);
const elLayers = $("#layers");
const elSamples = $("#samples");
const elRelations = $("#relations");
const elErrorBanner = $("#errorBanner");
const elErrorList = $("#errorList");
const elResultBody = $("#resultBody");
const elStatus = $("#status");
const elInferBody = $("#inferBody");

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
  invalidateInfer();
  solveTimer = setTimeout(runSolve, delay);
}

// 图层/样本/关系一旦变动，反推结果立即作废；已确认的顺序与勾选保留
// （顺序仅在图层集合变化时由 syncInferWithSolve 重置）
function invalidateInfer() {
  if (infer.result || infer.error) {
    infer.result = null;
    infer.error = null;
    if (elInferBody) renderInfer();
  }
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
  const payload = buildPayload();

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
      syncInferWithSolve();
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

// ------------------------------------------------------------ 不透明度反推 --

function buildPayload() {
  return {
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
}

// 求解成功后同步：图层集合变化时重置已确认顺序并清理失效勾选
function syncInferWithSolve() {
  const ids = state.layers.map((l) => l.id);
  const curKey = [...ids].sort().join("\u0001");
  const orderKey = [...infer.order].sort().join("\u0001");
  if (orderKey !== curKey) {
    infer.order = [...ids];
    infer.tuneIds = infer.tuneIds.filter((id) => ids.includes(id));
    infer.result = null;
    infer.error = null;
    renderInfer();
  }
}

function renderInfer() {
  if (infer.order.length === 0) {
    elInferBody.innerHTML = `<div class="result-empty">先完成一次叠序校准…</div>`;
    return;
  }

  const layersById = new Map(state.layers.map((l) => [l.id, l]));
  const rows = infer.order
    .map((id, k) => {
      const layer = layersById.get(id);
      const color = layer && normalizeHex(layer.color) ? normalizeHex(layer.color) : "#000000";
      const alpha = layer && typeof layer.opacity === "number" ? layer.opacity : null;
      const checked = infer.tuneIds.includes(id);
      const disabled = !checked && infer.tuneIds.length >= 2;
      return `
        <div class="infer-row${checked ? " is-tune" : ""}">
          <span class="row-index">${k + 1}</span>
          <label class="tune-check" title="勾选为待调图层（至多 2 个）">
            <input type="checkbox" data-act="infer-toggle" data-id="${escapeHtml(id)}"
                   ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
            待调
          </label>
          <span class="dot-sm" style="background:${hexToRgba(color, alpha ?? 1)}"></span>
          <span class="cid-sm">${escapeHtml(id)}</span>
          <span class="cop-sm">${alpha === null ? "α=—" : "α=" + Number(alpha.toFixed(2))}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-small" data-act="infer-up" data-i="${k}"
                  type="button" ${k === 0 ? "disabled" : ""} title="上移（更靠近顶）">▲</button>
          <button class="btn btn-ghost btn-small" data-act="infer-down" data-i="${k}"
                  type="button" ${k === infer.order.length - 1 ? "disabled" : ""}
                  title="下移（更靠近底）">▼</button>
        </div>`;
    })
    .join("");

  const canRun = infer.tuneIds.length >= 1 && infer.tuneIds.length <= 2;
  const errorHtml = infer.error
    ? `<div class="infer-error"><div class="error-title">无法反推：</div><ul>
         ${(infer.error.errors || [{ message: infer.error.message || "反推失败" }])
           .map((er) => `<li>${escapeHtml(er.message)}</li>`)
           .join("")}
       </ul></div>`
    : "";

  elInferBody.innerHTML = `
    <div class="order-title">确认底 → 顶顺序（▲ 上移到更靠顶；勾选 1～2 个待调图层，其余保留原不透明度）</div>
    <div class="infer-rows">
      <div class="infer-end">底</div>
      ${rows}
      <div class="infer-end">↑ 顶</div>
    </div>
    <div class="infer-actions">
      <button id="inferRunBtn" class="btn btn-small" type="button" ${canRun ? "" : "disabled"}>
        ${infer.busy ? "反推计算中…" : "开始反推不透明度"}
      </button>
      <span class="hint">
        ${canRun
          ? `待调：${infer.tuneIds.map(escapeHtml).join("、")}，网格 0.00～1.00 步长 0.01（含原始参数组）`
          : "请勾选 1～2 个待调图层"}
      </span>
    </div>
    ${errorHtml}
    <div id="inferResult"></div>
  `;

  const btn = $("#inferRunBtn");
  if (btn) btn.addEventListener("click", runInfer);
  renderInferResult();
}

function renderInferResult() {
  const box = $("#inferResult");
  if (!box) return;
  const r = infer.result;
  if (!r) {
    box.innerHTML = "";
    return;
  }

  const layersById = new Map(state.layers.map((l) => [l.id, l]));
  const tuneRows = r.tune
    .map((t) => {
      const layer = layersById.get(t.id);
      const color = layer && normalizeHex(layer.color) ? normalizeHex(layer.color) : "#000000";
      const delta = t.suggestedOpacity - t.originalOpacity;
      const deltaTxt =
        delta === 0 ? "不变" : (delta > 0 ? "＋" : "−") + Math.abs(delta).toFixed(2);
      return `
        <tr>
          <td><span class="dot-xs" style="background:${hexToRgba(color, 1)}"></span>${escapeHtml(t.id)}</td>
          <td>${Number(t.originalOpacity.toFixed(2))}</td>
          <td class="sug-cell">${Number(t.suggestedOpacity.toFixed(2))}</td>
          <td class="${delta > 0 ? "r-up" : delta < 0 ? "r-down" : ""}">${deltaTxt}</td>
        </tr>`;
    })
    .join("");

  const improved = r.afterTotalSse < r.beforeTotalSse;
  box.innerHTML = `
    <div class="infer-result">
      <div class="metric-row">
        <span>调整前总误差：<b>${fmtSse(r.beforeTotalSse)}</b></span>
        <span>调整后总误差：<b class="${improved ? "r-good" : ""}">${fmtSse(r.afterTotalSse)}</b></span>
        <span>评估组合：<b>${r.combinationsChecked}</b> 组</span>
        <span>同分时按 ID 字典序参数元组决胜</span>
      </div>
      <table class="tune-table">
        <thead><tr><th>待调图层</th><th>原值</th><th>建议值</th><th>变化</th></tr></thead>
        <tbody>${tuneRows}</tbody>
      </table>
      <div class="infer-apply-row">
        <button id="inferApplyBtn" class="btn btn-small" type="button">应用建议值到图层并重新求解</button>
      </div>
      ${r.samples.map(renderInferSample).join("")}
    </div>
  `;
  $("#inferApplyBtn").addEventListener("click", applySuggestions);
}

function renderInferSample(s) {
  const rgbTxt = (p) => p.predictedRgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="sample-result infer-sample">
      <div class="sample-result-head">
        <span>样本 ${s.index + 1}</span>
        <span>SSE：${fmtSse(s.before.sse)} → <b class="${s.after.sse < s.before.sse ? "r-good" : ""}">${fmtSse(s.after.sse)}</b></span>
      </div>
      <div class="infer-compare">
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.target}"></span>
          <span class="swatch-meta">
            <div class="name">目标色</div>
            <div class="hexval">${s.target}</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.before.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">调整前预测</div>
            <div class="hexval">${s.before.predictedHex}</div>
            <div class="name">rgb(${rgbTxt(s.before)})</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big sug-swatch" style="background:${s.after.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">调整后预测</div>
            <div class="hexval">${s.after.predictedHex}</div>
            <div class="name">rgb(${rgbTxt(s.after)})</div>
          </span>
        </div>
      </div>
      <div class="bg-note">
        <span class="mini" style="background:${s.background}"></span>
        在背景 ${s.background} 上叠放
      </div>
    </div>
  `;
}

async function runInfer() {
  const payload = {
    ...buildPayload(),
    order: infer.order,
    tuneIds: infer.tuneIds,
  };
  infer.busy = true;
  infer.error = null;
  renderInfer();
  try {
    const resp = await fetch("/api/infer-opacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      infer.error = { errors: data.errors || [{ message: "反推失败" }] };
    } else {
      infer.result = data;
      infer.fingerprint = JSON.stringify(buildPayload());
      infer.error = null;
    }
  } catch (err) {
    infer.error = { message: "无法连接计算服务：" + err.message };
  } finally {
    infer.busy = false;
    renderInfer();
  }
}

function applySuggestions() {
  const r = infer.result;
  if (!r) return;
  for (const t of r.tune) {
    const layer = state.layers.find((l) => l.id === t.id);
    if (layer) layer.opacity = Number(t.suggestedOpacity.toFixed(2));
  }
  infer.result = null;
  infer.error = null;
  render();
  scheduleSolve(0);
  renderInfer();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act^='infer-']");
  if (!t) return;
  const act = t.dataset.act;
  const i = Number(t.dataset.i);

  if (act === "infer-up" && i > 0) {
    [infer.order[i - 1], infer.order[i]] = [infer.order[i], infer.order[i - 1]];
    infer.result = null;
    renderInfer();
  } else if (act === "infer-down" && i < infer.order.length - 1) {
    [infer.order[i + 1], infer.order[i]] = [infer.order[i], infer.order[i + 1]];
    infer.result = null;
    renderInfer();
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.act !== "infer-toggle") return;
  const id = t.dataset.id;
  if (t.checked) {
    if (!infer.tuneIds.includes(id) && infer.tuneIds.length < 2) infer.tuneIds.push(id);
  } else {
    infer.tuneIds = infer.tuneIds.filter((x) => x !== id);
  }
  infer.result = null;
  renderInfer();
});

// ------------------------------------------------------------ 启动 --
render();
renderInfer();
runSolve();
