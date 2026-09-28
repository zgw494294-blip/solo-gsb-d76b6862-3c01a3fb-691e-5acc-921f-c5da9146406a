"""透明图层叠序校准台 —— 纯标准库计算核心。

- sRGB <-> 线性光分段转换（IEC 61966-2-1）
- 线性光空间内逐层 alpha 合成（Porter-Duff "over"）
- 枚举全部底到顶排列，按未取整 RGB 通道平方误差总和选优
- 同分时按 ID 序列字典序决胜
- 顺序确定后，联合扫描 1～2 个图层的不透明度反推建议值
"""

from __future__ import annotations

import itertools
import math
import re
from typing import Any

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

MAX_LAYERS = 7
MIN_LAYERS = 2
MAX_SAMPLES = 4
MIN_SAMPLES = 1
MAX_RELATIONS = 12
MAX_TUNE_LAYERS = 2
OPACITY_STEPS = 101  # 0.00 ~ 1.00，步长 0.01


class CalibrationError(Exception):
    """输入校验失败，errors 为可直接展示给用户的中文错误列表。"""

    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__("; ".join(e["message"] for e in errors))
        self.errors = errors


def _err(scope: str, message: str, index: int | None = None) -> dict[str, Any]:
    e: dict[str, Any] = {"scope": scope, "message": message}
    if index is not None:
        e["index"] = index
    return e


# ---------------------------------------------------------------- 颜色基础 --


def parse_hex(text: Any) -> tuple[str, tuple[float, float, float]]:
    """把 '#rgb' / '#rrggbb'（# 可省略）解析为 (规范 hex, 0~1 sRGB 三元组)。"""
    if not isinstance(text, str):
        raise ValueError("颜色必须是字符串")
    s = text.strip()
    m = _HEX_RE.fullmatch(s)
    if not m:
        raise ValueError(f"非法颜色 {text!r}：需要形如 #RRGGBB 的 HEX 值")
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    rgb = (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)
    return "#" + h.lower(), rgb


def srgb_to_linear(c: float) -> float:
    """sRGB 传递函数（0~1）-> 线性光。"""
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    """线性光 -> sRGB 传递函数（0~1）。"""
    if c <= 0.0031308:
        return 12.92 * c
    return 1.055 * (c ** (1.0 / 2.4)) - 0.055


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def over(
    bottom: tuple[float, float, float, float],
    top: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """线性光空间内的 Porter-Duff "over" 合成（两者均为预乘表示）。"""
    br, bg, bb, ba = bottom
    tr, tg, tb, ta = top
    out_a = ta + ba * (1.0 - ta)
    if out_a <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)

    def chan(tc: float, bc: float) -> float:
        return (tc * ta + bc * ba * (1.0 - ta)) / out_a

    return (chan(tr, br), chan(tg, bg), chan(tb, bb), out_a)


def render_stack(
    background_srgb: tuple[float, float, float],
    order: list[int],
    layer_colors_lin: list[tuple[float, float, float]],
    layer_alphas: list[float],
) -> tuple[float, float, float]:
    """以不透明背景打底，按底到顶 order 逐层合成，返回 sRGB(0~1) 结果色。"""
    r, g, b = (srgb_to_linear(v) for v in background_srgb)
    cur = (r, g, b, 1.0)
    for idx in order:
        lr, lg, lb = layer_colors_lin[idx]
        cur = over(cur, (lr, lg, lb, layer_alphas[idx]))
    out = tuple(_clamp01(linear_to_srgb(cur[c])) for c in range(3))
    return out  # type: ignore[return-value]


# ----------------------------------------------------------------- 环检测 --


def _find_cycle(adj: list[list[int]]) -> list[int] | None:
    """DFS 找有向图中的环，返回环上节点下标序列（首尾相同），无环返回 None。"""
    n = len(adj)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = [WHITE] * n
    parent = [-1] * n

    def dfs(u: int) -> list[int] | None:
        color[u] = GRAY
        for v in adj[u]:
            if color[v] == GRAY:  # 自环与回边均落在此处
                path = [u]
                cur = u
                while cur != v:
                    cur = parent[cur]
                    path.append(cur)
                path.reverse()
                path.append(v)
                return path
            if color[v] == WHITE:
                parent[v] = u
                found = dfs(v)
                if found is not None:
                    return found
        color[u] = BLACK
        return None

    for start in range(n):
        if color[start] == WHITE:
            found = dfs(start)
            if found is not None:
                return found
    return None


# ------------------------------------------------------------- 输入解析 --


class _Inputs:
    """图层 / 样本 / 关系解析与成环检测后的共享数据。"""

    __slots__ = (
        "n",
        "layer_ids",
        "layer_hex",
        "layer_lin",
        "layer_alpha",
        "samples_bg_hex",
        "samples_bg_srgb",
        "samples_tg_hex",
        "samples_tg_srgb",
        "pairs",
    )

    def __init__(self) -> None:
        self.n = 0
        self.layer_ids: list[str] = []
        self.layer_hex: list[str] = []
        self.layer_lin: list[tuple[float, float, float]] = []
        self.layer_alpha: list[float] = []
        self.samples_bg_hex: list[str] = []
        self.samples_bg_srgb: list[tuple[float, float, float]] = []
        self.samples_tg_hex: list[str] = []
        self.samples_tg_srgb: list[tuple[float, float, float]] = []
        self.pairs: list[tuple[int, int]] = []


def _parse_inputs(payload: Any) -> _Inputs:
    """解析图层、样本、先后关系并做成环检测；任一非法即抛 CalibrationError。"""
    if not isinstance(payload, dict):
        raise CalibrationError([_err("form", "请求体必须是 JSON 对象")])

    errors: list[dict[str, Any]] = []

    raw_layers = payload.get("layers")
    raw_samples = payload.get("samples")
    raw_relations = payload.get("relations", [])

    # ---- 图层 -------------------------------------------------------------
    if not isinstance(raw_layers, list):
        raise CalibrationError([_err("layers", "缺少 layers 列表或其格式不正确")])
    if not (MIN_LAYERS <= len(raw_layers) <= MAX_LAYERS):
        errors.append(
            _err("layers", f"图层数量必须在 {MIN_LAYERS}～{MAX_LAYERS} 个之间，当前 {len(raw_layers)} 个")
        )

    layer_ids: list[str] = []
    layer_hex: list[str] = []
    layer_lin: list[tuple[float, float, float]] = []
    layer_alpha: list[float] = []
    seen_ids: dict[str, int] = {}

    for i, item in enumerate(raw_layers):
        if not isinstance(item, dict):
            errors.append(_err("layers", "图层数据格式不正确，应为对象", i))
            continue

        lid = item.get("id")
        if not isinstance(lid, str) or not lid.strip():
            errors.append(_err("layers", "图层 ID 不能为空", i))
            lid = ""
        else:
            lid = lid.strip()
            if lid in seen_ids:
                errors.append(_err("layers", f"图层 ID 重复：{lid}", i))
            else:
                seen_ids[lid] = i

        try:
            norm, rgb = parse_hex(item.get("color"))
        except ValueError as exc:
            errors.append(_err("layers", str(exc), i))
            norm, rgb = "#000000", (0.0, 0.0, 0.0)

        opacity = item.get("opacity")
        if isinstance(opacity, bool) or not isinstance(opacity, (int, float)) or not math.isfinite(opacity):
            errors.append(_err("layers", f"不透明度必须是 0～1 的数字（图层 {lid or i + 1}）", i))
            opacity = 1.0
        elif not (0.0 <= float(opacity) <= 1.0):
            errors.append(
                _err("layers", f"不透明度越界：{opacity}，必须在 0～1 之间（图层 {lid or i + 1}）", i)
            )
            opacity = 1.0

        layer_ids.append(lid)
        layer_hex.append(norm)
        layer_lin.append(tuple(srgb_to_linear(c) for c in rgb))  # type: ignore[arg-type]
        layer_alpha.append(float(opacity))

    # ---- 样本 -------------------------------------------------------------
    if not isinstance(raw_samples, list):
        raise CalibrationError([_err("samples", "缺少 samples 列表或其格式不正确")])
    if not (MIN_SAMPLES <= len(raw_samples) <= MAX_SAMPLES):
        errors.append(
            _err("samples", f"样本（背景/目标）组数必须在 {MIN_SAMPLES}～{MAX_SAMPLES} 之间，当前 {len(raw_samples)} 组")
        )

    samples_bg_hex: list[str] = []
    samples_bg_srgb: list[tuple[float, float, float]] = []
    samples_tg_hex: list[str] = []
    samples_tg_srgb: list[tuple[float, float, float]] = []

    for i, item in enumerate(raw_samples):
        if not isinstance(item, dict):
            errors.append(_err("samples", "样本数据格式不正确，应为对象", i))
            continue
        for field, label, sink_hex, sink_rgb in (
            ("background", "背景色", samples_bg_hex, samples_bg_srgb),
            ("target", "目标色", samples_tg_hex, samples_tg_srgb),
        ):
            try:
                norm, rgb = parse_hex(item.get(field))
            except ValueError:
                errors.append(_err("samples", f"{label}非法：需要形如 #RRGGBB 的 HEX 值，实际为 {item.get(field)!r}", i))
                norm, rgb = "#000000", (0.0, 0.0, 0.0)
            sink_hex.append(norm)
            sink_rgb.append(rgb)

    # ---- 先后关系 ---------------------------------------------------------
    if not isinstance(raw_relations, list):
        errors.append(_err("relations", "relations 字段格式不正确，应为数组"))
        raw_relations = []
    if len(raw_relations) > MAX_RELATIONS:
        errors.append(
            _err("relations", f"图层先后关系至多 {MAX_RELATIONS} 条，当前 {len(raw_relations)} 条")
        )

    id_set = {lid for lid in layer_ids if lid}
    pairs: list[tuple[int, int]] = []
    pair_seen: set[tuple[int, int]] = set()
    for i, item in enumerate(raw_relations[:MAX_RELATIONS]):
        if not isinstance(item, dict):
            errors.append(_err("relations", "关系数据格式不正确，应为对象", i))
            continue
        lower, upper = item.get("lower"), item.get("upper")
        if not isinstance(lower, str) or lower.strip() not in id_set:
            errors.append(_err("relations", f"关系下方图层 ID 不存在：{lower!r}", i))
            continue
        if not isinstance(upper, str) or upper.strip() not in id_set:
            errors.append(_err("relations", f"关系上方图层 ID 不存在：{upper!r}", i))
            continue
        lower, upper = lower.strip(), upper.strip()
        li, ui = seen_ids[lower], seen_ids[upper]
        key = (li, ui)
        if key in pair_seen:
            continue  # 重复关系直接去重
        pair_seen.add(key)
        pairs.append((li, ui))

    if errors:
        raise CalibrationError(errors)

    # ---- 成环检测 ---------------------------------------------------------
    n = len(layer_ids)
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in pairs:
        adj[li].append(ui)
    cycle = _find_cycle(adj)
    if cycle is not None:
        chain = " → ".join(layer_ids[x] for x in cycle)
        raise CalibrationError(
            [_err("relations", f"图层先后关系成环，存在冲突：{chain}（底 → 顶方向不能绕回自身）")]
        )

    data = _Inputs()
    data.n = n
    data.layer_ids = layer_ids
    data.layer_hex = layer_hex
    data.layer_lin = layer_lin
    data.layer_alpha = layer_alpha
    data.samples_bg_hex = samples_bg_hex
    data.samples_bg_srgb = samples_bg_srgb
    data.samples_tg_hex = samples_tg_hex
    data.samples_tg_srgb = samples_tg_srgb
    data.pairs = pairs
    return data


# ------------------------------------------------------------- 误差评估 --


def _evaluate(
    data: _Inputs,
    order_idx: list[int],
    alphas: list[float],
) -> tuple[float, list[dict[str, Any]]]:
    """按未取整 RGB × 255 平方误差口径评估给定顺序/不透明度，返回 (总SSE, 各样本明细)。"""
    total_sse = 0.0
    details: list[dict[str, Any]] = []
    for s in range(len(data.samples_bg_srgb)):
        pred = render_stack(data.samples_bg_srgb[s], order_idx, data.layer_lin, alphas)
        pred255 = [_clamp01(pred[c]) * 255.0 for c in range(3)]
        tgt255 = [data.samples_tg_srgb[s][c] * 255.0 for c in range(3)]
        channel_sse = [(pred255[c] - tgt255[c]) ** 2 for c in range(3)]
        sse = sum(channel_sse)
        total_sse += sse
        rounded = [max(0, min(255, int(round(v)))) for v in pred255]
        details.append(
            {
                "predictedRgb": pred255,
                "predictedHex": "#{:02x}{:02x}{:02x}".format(*rounded),
                "targetRgb": tgt255,
                "channelSse": channel_sse,
                "sse": sse,
            }
        )
    return total_sse, details


# ------------------------------------------------------------------- 求解 --


def solve(payload: Any) -> dict[str, Any]:
    data = _parse_inputs(payload)
    n = data.n

    # ---- 枚举排列并选优 ---------------------------------------------------
    def feasible(perm: tuple[int, ...]) -> bool:
        pos = [0] * n
        for p, idx in enumerate(perm):
            pos[idx] = p
        return all(pos[li] < pos[ui] for li, ui in data.pairs)

    best_sse = math.inf
    best_key: tuple[float, tuple[str, ...]] | None = None
    best_perm: tuple[int, ...] | None = None
    feasible_count = 0
    total_count = math.factorial(n)

    for perm in itertools.permutations(range(n)):
        if not feasible(perm):
            continue
        feasible_count += 1
        total_sse = 0.0
        for s in range(len(data.samples_bg_hex)):
            pred = render_stack(data.samples_bg_srgb[s], list(perm), data.layer_lin, data.layer_alpha)
            for c in range(3):
                diff = pred[c] * 255.0 - data.samples_tg_srgb[s][c] * 255.0
                total_sse += diff * diff
        id_seq = tuple(data.layer_ids[idx] for idx in perm)
        if best_key is None or (total_sse, id_seq) < best_key:
            best_sse = total_sse
            best_key = (total_sse, id_seq)
            best_perm = perm

    # 有环已在解析时拦截；这里仅作防御
    if best_perm is None:  # pragma: no cover
        raise CalibrationError([_err("relations", "约束过强，没有任何可行的图层顺序")])

    total_sse = best_sse
    assert best_perm is not None

    # ---- 组装各样本明细 ---------------------------------------------------
    sample_results: list[dict[str, Any]] = []
    for s, detail in enumerate(_evaluate(data, list(best_perm), data.layer_alpha)[1]):
        sample_results.append(
            {
                "index": s,
                "background": data.samples_bg_hex[s],
                "target": data.samples_tg_hex[s],
                **detail,
            }
        )

    return {
        "order": [data.layer_ids[idx] for idx in best_perm],
        "orderIndexes": list(best_perm),
        "layers": [
            {"id": data.layer_ids[i], "color": data.layer_hex[i], "opacity": data.layer_alpha[i]}
            for i in best_perm
        ],
        "totalSse": total_sse,
        "permutationsChecked": total_count,
        "feasibleCount": feasible_count,
        "samples": sample_results,
    }


# ------------------------------------------------------- 不透明度反推 --


def _parse_order(payload: Any, data: _Inputs) -> tuple[list[str] | None, list[dict[str, Any]]]:
    """校验底到顶顺序：必须是恰好包含全部图层 ID 各一次、且满足先后关系的数组。"""
    errors: list[dict[str, Any]] = []
    raw_order = payload.get("order")
    if not isinstance(raw_order, list):
        errors.append(
            _err("order", "缺少 order 字段或其格式不正确：需按底 → 顶顺序给出全部图层 ID 的数组")
        )
        return None, errors

    n = data.n
    if len(raw_order) != n:
        errors.append(
            _err("order", f"底 → 顶顺序必须恰好包含全部 {n} 个图层 ID，当前给出 {len(raw_order)} 个")
        )

    id_to_index = {lid: i for i, lid in enumerate(data.layer_ids)}
    order_ids: list[str] = []
    seen: set[str] = set()
    for k, item in enumerate(raw_order):
        if not isinstance(item, str) or not item.strip():
            errors.append(_err("order", f"顺序第 {k + 1} 项不是有效的图层 ID"))
            continue
        lid = item.strip()
        if lid not in id_to_index:
            errors.append(_err("order", f"顺序中的图层 ID 不存在：{lid}"))
            continue
        if lid in seen:
            errors.append(_err("order", f"顺序中图层 ID 重复：{lid}（每个图层须恰好出现一次）"))
            continue
        seen.add(lid)
        order_ids.append(lid)

    if errors or len(order_ids) != n:
        return None, errors

    pos = {lid: p for p, lid in enumerate(order_ids)}
    for li, ui in data.pairs:
        lower, upper = data.layer_ids[li], data.layer_ids[ui]
        if pos[lower] > pos[upper]:
            errors.append(
                _err("order", f"顺序不满足先后关系：{lower} 必须在 {upper} 的更下方（底 → 顶方向）")
            )
    if errors:
        return None, errors
    return order_ids, errors


def _parse_tune_ids(payload: Any, data: _Inputs) -> tuple[list[str] | None, list[dict[str, Any]]]:
    """校验待调图层 ID：1～2 个、不可重复、必须存在。"""
    errors: list[dict[str, Any]] = []
    raw_tune = payload.get("tuneIds")
    if not isinstance(raw_tune, list):
        errors.append(
            _err("tune", "缺少 tuneIds 字段或其格式不正确：需给出 1～2 个待反推不透明度的图层 ID 数组")
        )
        return None, errors

    if not (1 <= len(raw_tune) <= MAX_TUNE_LAYERS):
        errors.append(
            _err("tune", f"待调图层必须为 1～{MAX_TUNE_LAYERS} 个，当前为 {len(raw_tune)} 个")
        )

    id_set = set(data.layer_ids)
    tune_ids: list[str] = []
    seen: set[str] = set()
    for k, item in enumerate(raw_tune):
        if not isinstance(item, str) or not item.strip():
            errors.append(_err("tune", f"待调图层 ID 第 {k + 1} 项不是有效字符串"))
            continue
        lid = item.strip()
        if lid not in id_set:
            errors.append(_err("tune", f"待调图层 ID 不存在：{lid}"))
            continue
        if lid in seen:
            errors.append(_err("tune", f"待调图层 ID 重复：{lid}"))
            continue
        seen.add(lid)
        tune_ids.append(lid)

    if errors:
        return None, errors
    tune_ids.sort()  # 统一按 ID 字典序：参数元组决胜与输出均以此为准
    return tune_ids, errors


def infer_opacities(payload: Any) -> dict[str, Any]:
    """顺序固定时，联合扫描 1～2 个图层的不透明度，按总 SSE 最小反推建议值。"""
    data = _parse_inputs(payload)

    order_ids, order_errors = _parse_order(payload, data)
    tune_ids, tune_errors = _parse_tune_ids(payload, data)
    errors = order_errors + tune_errors
    if errors:
        raise CalibrationError(errors)

    assert order_ids is not None and tune_ids is not None
    order_idx = [data.layer_ids.index(lid) for lid in order_ids]
    tune_idx = [data.layer_ids.index(lid) for lid in tune_ids]

    # ---- 联合网格（含原始参数组） ------------------------------------------
    grid = [k / 100.0 for k in range(OPACITY_STEPS)]
    original_combo = tuple(data.layer_alpha[i] for i in tune_idx)
    combos = sorted(set(itertools.product(grid, repeat=len(tune_idx))) | {original_combo})

    best_key: tuple[float, tuple[float, ...]] | None = None
    best_combo: tuple[float, ...] | None = None
    for combo in combos:
        alphas = data.layer_alpha.copy()
        for j, layer_idx in enumerate(tune_idx):
            alphas[layer_idx] = combo[j]
        total_sse, _ = _evaluate(data, order_idx, alphas)
        key = (total_sse, combo)  # 同分：按 ID 字典序参数元组从小到大
        if best_key is None or key < best_key:
            best_key = key
            best_combo = combo

    assert best_key is not None and best_combo is not None
    suggested_alphas = data.layer_alpha.copy()
    for j, layer_idx in enumerate(tune_idx):
        suggested_alphas[layer_idx] = best_combo[j]
    before_sse, before_details = _evaluate(data, order_idx, data.layer_alpha)
    after_sse, after_details = _evaluate(data, order_idx, suggested_alphas)

    sample_results: list[dict[str, Any]] = []
    for s in range(len(data.samples_bg_srgb)):
        sample_results.append(
            {
                "index": s,
                "background": data.samples_bg_hex[s],
                "target": data.samples_tg_hex[s],
                "before": {k: before_details[s][k] for k in ("predictedRgb", "predictedHex", "targetRgb", "channelSse", "sse")},
                "after": {k: after_details[s][k] for k in ("predictedRgb", "predictedHex", "targetRgb", "channelSse", "sse")},
            }
        )

    return {
        "order": order_ids,
        "orderIndexes": order_idx,
        "tune": [
            {
                "id": tune_ids[j],
                "originalOpacity": original_combo[j],
                "suggestedOpacity": best_combo[j],
            }
            for j in range(len(tune_idx))
        ],
        "beforeTotalSse": before_sse,
        "afterTotalSse": after_sse,
        "combinationsChecked": len(combos),
        "samples": sample_results,
    }
