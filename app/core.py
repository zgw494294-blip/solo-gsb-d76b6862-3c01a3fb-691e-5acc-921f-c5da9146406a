"""透明图层叠序校准台 —— 纯标准库计算核心。

- sRGB <-> 线性光分段转换（IEC 61966-2-1）
- 线性光空间内逐层 alpha 合成（Porter-Duff "over"）
- 枚举全部底到顶排列，按未取整 RGB 通道平方误差总和选优
- 同分时按 ID 序列字典序决胜
- 图层顺序确定后，可在 0.00～1.00（步长 0.01）网格上联合反推 1～2 个图层的不透明度
"""

from __future__ import annotations

import itertools
import math
import re
from dataclasses import dataclass
from typing import Any

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

MAX_LAYERS = 7
MIN_LAYERS = 2
MAX_SAMPLES = 4
MIN_SAMPLES = 1
MAX_RELATIONS = 12
OPACITY_STEPS = 101  # 0.00～1.00，步长 0.01
MAX_ADJUST = 2
MIN_ADJUST = 1


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


# --------------------------------------------------------- 输入解析（共用） --


@dataclass
class _Parsed:
    ids: list[str]
    hexes: list[str]
    lins: list[tuple[float, float, float]]
    alphas: list[float]
    seen_ids: dict[str, int]
    bg_hex: list[str]
    bg_srgb: list[tuple[float, float, float]]
    tg_hex: list[str]
    tg_srgb: list[tuple[float, float, float]]
    pairs: list[tuple[int, int]]


def _parse_inputs(payload: Any) -> tuple[_Parsed, list[dict[str, Any]]]:
    """解析 layers/samples/relations。结构性致命错误直接抛，字段错误收集后返回。"""
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

    parsed = _Parsed(
        ids=layer_ids,
        hexes=layer_hex,
        lins=layer_lin,
        alphas=layer_alpha,
        seen_ids=seen_ids,
        bg_hex=samples_bg_hex,
        bg_srgb=samples_bg_srgb,
        tg_hex=samples_tg_hex,
        tg_srgb=samples_tg_srgb,
        pairs=pairs,
    )
    return parsed, errors


def _raise_if_cycle(parsed: _Parsed) -> None:
    n = len(parsed.ids)
    adj: list[list[int]] = [[] for _ in range(n)]
    for li, ui in parsed.pairs:
        adj[li].append(ui)
    cycle = _find_cycle(adj)
    if cycle is not None:
        chain = " → ".join(parsed.ids[x] for x in cycle)
        raise CalibrationError(
            [_err("relations", f"图层先后关系成环，存在冲突：{chain}（底 → 顶方向不能绕回自身）")]
        )


def _total_sse(
    parsed: _Parsed, order: list[int], alphas: list[float]
) -> float:
    """给定顺序与不透明度，计算全部样本未取整 RGB 平方误差总和。"""
    total = 0.0
    for s in range(len(parsed.bg_hex)):
        pred = render_stack(parsed.bg_srgb[s], order, parsed.lins, alphas)
        for c in range(3):
            diff = pred[c] * 255.0 - parsed.tg_srgb[s][c] * 255.0
            total += diff * diff
    return total


def _sample_details(
    parsed: _Parsed, order: list[int], alphas: list[float]
) -> tuple[list[dict[str, Any]], float]:
    """组装每个样本的预测色与分通道误差，并返回总 SSE。"""
    results: list[dict[str, Any]] = []
    total = 0.0
    for s in range(len(parsed.bg_hex)):
        pred = render_stack(parsed.bg_srgb[s], order, parsed.lins, alphas)
        pred255 = [_clamp01(pred[c]) * 255.0 for c in range(3)]
        tgt255 = [parsed.tg_srgb[s][c] * 255.0 for c in range(3)]
        channel_sse = [(pred255[c] - tgt255[c]) ** 2 for c in range(3)]
        sse = sum(channel_sse)
        total += sse
        rounded = [max(0, min(255, int(round(v)))) for v in pred255]
        results.append(
            {
                "index": s,
                "background": parsed.bg_hex[s],
                "target": parsed.tg_hex[s],
                "predictedRgb": pred255,
                "predictedHex": "#{:02x}{:02x}{:02x}".format(*rounded),
                "targetRgb": tgt255,
                "channelSse": channel_sse,
                "sse": sse,
            }
        )
    return results, total


# ------------------------------------------------------------------- 求解 --


def solve(payload: Any) -> dict[str, Any]:
    parsed, errors = _parse_inputs(payload)
    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)

    n = len(parsed.ids)
    pairs = parsed.pairs

    # ---- 枚举排列并选优 ---------------------------------------------------
    def feasible(perm: tuple[int, ...]) -> bool:
        pos = [0] * n
        for p, idx in enumerate(perm):
            pos[idx] = p
        return all(pos[li] < pos[ui] for li, ui in pairs)

    best_sse = math.inf
    best_key: tuple[float, tuple[str, ...]] | None = None
    best_perm: tuple[int, ...] | None = None
    feasible_count = 0
    total_count = math.factorial(n)

    for perm in itertools.permutations(range(n)):
        if not feasible(perm):
            continue
        feasible_count += 1
        total_sse = _total_sse(parsed, list(perm), parsed.alphas)
        id_seq = tuple(parsed.ids[idx] for idx in perm)
        if best_key is None or (total_sse, id_seq) < best_key:
            best_sse = total_sse
            best_key = (total_sse, id_seq)
            best_perm = perm

    # 有环已在上面拦截；这里仅作防御
    if best_perm is None:  # pragma: no cover
        raise CalibrationError([_err("relations", "约束过强，没有任何可行的图层顺序")])

    assert best_perm is not None
    # 与 infer_opacities 的「调整前」走同一明细汇总，保证两边 totalSse 逐位一致
    sample_results, total_sse = _sample_details(parsed, list(best_perm), parsed.alphas)

    return {
        "order": [parsed.ids[idx] for idx in best_perm],
        "orderIndexes": list(best_perm),
        "layers": [
            {"id": parsed.ids[i], "color": parsed.hexes[i], "opacity": parsed.alphas[i]}
            for i in best_perm
        ],
        "totalSse": total_sse,
        "permutationsChecked": total_count,
        "feasibleCount": feasible_count,
        "samples": sample_results,
    }


# --------------------------------------------------------- 不透明度反推 --


def infer_opacities(payload: Any) -> dict[str, Any]:
    """顺序固定、其余图层不透明度保留原值，网格联合反推 1～2 个图层的不透明度。"""
    parsed, errors = _parse_inputs(payload)
    n = len(parsed.ids)
    id_set = {lid for lid in parsed.ids if lid}

    # ---- 底到顶顺序 -------------------------------------------------------
    raw_order = payload.get("order") if isinstance(payload, dict) else None
    order_ids: list[str] = []
    order_valid = True
    if not isinstance(raw_order, list):
        errors.append(
            _err("order", "缺少 order 列表或其格式不正确：必须按底→顶顺序给出全部图层 ID")
        )
        order_valid = False
    else:
        if len(raw_order) != n:
            errors.append(
                _err("order", f"order 必须恰好包含全部 {n} 个图层 ID（各一次），当前 {len(raw_order)} 个")
            )
            order_valid = False
        seen_order: set[str] = set()
        for x in raw_order:
            if not isinstance(x, str) or not x.strip():
                errors.append(_err("order", f"order 中的图层 ID 非法：{x!r}（必须是已存在的图层 ID）"))
                order_valid = False
                continue
            x = x.strip()
            if x not in id_set:
                errors.append(_err("order", f"order 中的图层 ID 不存在：{x!r}"))
                order_valid = False
            elif x in seen_order:
                errors.append(
                    _err("order", f"order 中图层 ID 重复：{x}，每个图层必须且只能出现一次")
                )
                order_valid = False
            else:
                seen_order.add(x)
            order_ids.append(x)

    # ---- 待调图层 ---------------------------------------------------------
    raw_adjust = payload.get("adjustIds") if isinstance(payload, dict) else None
    adjust_ids: list[str] = []
    if not isinstance(raw_adjust, list):
        errors.append(
            _err("adjust", "缺少 adjustIds 列表或其格式不正确：必须选择 1～2 个待反推图层 ID")
        )
    else:
        if not (MIN_ADJUST <= len(raw_adjust) <= MAX_ADJUST):
            errors.append(
                _err("adjust", f"待调图层必须为 {MIN_ADJUST}～{MAX_ADJUST} 个，当前 {len(raw_adjust)} 个")
            )
        seen_adjust: set[str] = set()
        for x in raw_adjust:
            if not isinstance(x, str) or not x.strip() or x.strip() not in id_set:
                errors.append(_err("adjust", f"待调图层 ID 不存在：{x!r}"))
                continue
            x = x.strip()
            if x in seen_adjust:
                errors.append(_err("adjust", f"待调图层 ID 重复：{x}，同一图层只能选择一次"))
                continue
            seen_adjust.add(x)
            adjust_ids.append(x)

    if errors:
        raise CalibrationError(errors)
    _raise_if_cycle(parsed)

    order_idx = [parsed.seen_ids[x] for x in order_ids]

    # ---- 顺序必须符合先后关系 ---------------------------------------------
    pos = [0] * n
    for p, idx in enumerate(order_idx):
        pos[idx] = p
    for li, ui in parsed.pairs:
        if pos[li] >= pos[ui]:
            raise CalibrationError(
                [
                    _err(
                        "order",
                        f"所给顺序不符合先后关系：{parsed.ids[li]} 必须在 {parsed.ids[ui]} 下方（底 → 顶）",
                    )
                ]
            )

    # 待调图层按 ID 字典序排列，元组决胜均以此顺序为准
    adjust_ids = sorted(adjust_ids)
    adjust_idx = [parsed.seen_ids[x] for x in adjust_ids]
    k = len(adjust_idx)
    original_tuple = tuple(round(parsed.alphas[i], 10) for i in adjust_idx)
    original_on_grid = all(abs(a - round(a, 2)) <= 1e-9 for a in original_tuple)

    # ---- 联合遍历 0.00～1.00（步长 0.01），并额外纳入原始参数组 -----------
    best_sse = math.inf
    best_tuple: tuple[float, ...] | None = None

    def consider(values: tuple[float, ...], total_sse: float) -> None:
        nonlocal best_sse, best_tuple
        if best_tuple is None or (total_sse, values) < (best_sse, best_tuple):
            best_sse = total_sse
            best_tuple = values

    alphas = parsed.alphas.copy()
    for steps in itertools.product(range(OPACITY_STEPS), repeat=k):
        combo = tuple(s / 100.0 for s in steps)
        for j, ai in enumerate(adjust_idx):
            alphas[ai] = combo[j]
        consider(combo, _total_sse(parsed, order_idx, alphas))

    if not original_on_grid:
        for j, ai in enumerate(adjust_idx):
            alphas[ai] = original_tuple[j]
        consider(original_tuple, _total_sse(parsed, order_idx, alphas))

    combos_checked = OPACITY_STEPS**k + (0 if original_on_grid else 1)
    assert best_tuple is not None

    # ---- 调整前后明细（建议值即最优元组；若原始参数组最优则建议=原值）-------
    before_samples, before_total = _sample_details(parsed, order_idx, parsed.alphas)

    after_alphas = parsed.alphas.copy()
    for j, ai in enumerate(adjust_idx):
        after_alphas[ai] = best_tuple[j]
    after_samples, after_total = _sample_details(parsed, order_idx, after_alphas)

    adjustments = [
        {
            "id": adjust_ids[j],
            "index": adjust_idx[j],
            "originalOpacity": parsed.alphas[adjust_idx[j]],
            "suggestedOpacity": round(best_tuple[j], 10),
        }
        for j in range(k)
    ]

    return {
        "order": [parsed.ids[i] for i in order_idx],
        "orderIndexes": order_idx,
        "adjustIds": adjust_ids,
        "layers": [
            {"id": parsed.ids[i], "color": parsed.hexes[i], "opacity": parsed.alphas[i]}
            for i in order_idx
        ],
        "adjustments": adjustments,
        "beforeTotalSse": before_total,
        "afterTotalSse": after_total,
        "beforeSamples": before_samples,
        "afterSamples": after_samples,
        "combosChecked": combos_checked,
        "opacityGrid": {"min": 0.0, "max": 1.0, "step": 0.01},
    }
