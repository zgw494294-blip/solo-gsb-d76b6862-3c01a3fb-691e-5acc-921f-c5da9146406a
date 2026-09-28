# 透明图层叠序校准台

本地 Web 应用：录入若干个纯色半透明图层与多组「背景色 / 目标色」样本，自动枚举所有底 → 顶叠放顺序，找出对全部样本整体拟合最好的图层顺序。

- **后端**：Python + FastAPI（计算核心仅用标准库，便于审阅与测试）
- **前端**：原生 HTML / CSS / JavaScript，无任何构建步骤与外部 CDN 依赖
- **色彩管线**：标准 sRGB 分段函数 ↔ 线性光，在线性光空间做 Porter-Duff alpha 合成
- **择优准则**：所有样本、RGB 三通道在 **0–255 未取整** 尺度上的平方误差总和；总误差相同时，按图层 **ID 序列字典序** 决胜
- **不透明度反推**：叠放顺序确定后，选定 1～2 个图层，在 0.00～1.00（步长 0.01）网格上联合反推总误差最小的不透明度

## 一条命令启动

需要已安装 Docker（含 Compose 插件）。

```bash
docker compose up --build
```

启动后用浏览器访问：

```
http://localhost:8000
```

停止：在另一个终端执行 `docker compose down`（或 Ctrl+C 后再 `down` 清理容器）。

## 功能说明

| 区域 | 规则 |
| --- | --- |
| 图层 | 2～7 个；ID 必须唯一且非空；颜色支持 `#RGB` / `#RRGGBB`（`#` 可省略，大小写不限）；不透明度 0～1 |
| 样本 | 1～4 组「背景色 + 目标色」；所有样本共用同一底到顶顺序，误差跨样本求和 |
| 先后关系 | 0～12 条「某图层在更下方 / 另一图层在其上方」约束；形成有向环时明确提示冲突链，例如 `A → B → A` |
| 结果 | 最终顺序（带半透明色点、底→顶方向）、总平方误差、枚举/可行排列数；每个样本并排显示目标色与预测色、HEX、RGB 与 R/G/B 分通道平方误差 |
| 不透明度反推 | 在校准结果下方确认底 → 顶顺序（▲/▼ 调整）并勾选 1～2 个待调图层，其余图层保留原不透明度；联合遍历 0.00～1.00、步长 0.01 的不透明度组合（额外纳入原始参数组），显示原值 / 建议值 / 调整前后总误差 / 每组样本的调整前·后预测色；建议值可一键应用回图层并自动重新求解 |

输入任意改动后自动重新求解（带防抖），非法颜色、重复 ID、越界不透明度等错误会在页面顶部以中文逐条列出，并暂停计算。

### 色彩与合成细节

1. HEX → sRGB(0～1)；按 IEC 61966-2-1 分段函数转为线性光：
   - `c ≤ 0.04045`：`c / 12.92`
   - 否则：`((c + 0.055) / 1.055) ** 2.4`
2. 以不透明背景色（α=1）打底，按底到顶顺序逐层做 "over" 合成（预乘形式）。
3. 结果经逆函数转回 sRGB，误差比较使用未四舍五入的浮点 RGB × 255 值；页面上的预测 HEX 才是取整后的值。
4. 对 7 个图层最多枚举 7! = 5040 个排列，逐排列过滤约束并评估，响应为毫秒级。

## API

`POST /api/solve`

```json
{
  "layers": [
    { "id": "R", "color": "#ff0000", "opacity": 0.5 },
    { "id": "B", "color": "#0000ff", "opacity": 0.5 }
  ],
  "samples": [
    { "background": "#ffffff", "target": "#e189bc" }
  ],
  "relations": [
    { "lower": "R", "upper": "B" }
  ]
}
```

成功返回 `order`（底→顶 ID 序列）、`orderIndexes`、`layers`（同序）、`totalSse`、`permutationsChecked`、`feasibleCount` 及每个样本的 `target / predictedHex / predictedRgb / channelSse / sse`。

输入非法或约束成环时返回 HTTP 400：

```json
{ "errors": [ { "scope": "layers", "index": 0, "message": "不透明度越界：1.2，必须在 0～1 之间" } ] }
```

`scope` 取值为 `layers` / `samples` / `relations` / `form`。

### `POST /api/infer-opacity` — 不透明度反推

顺序确定后，由目标色反推 1～2 个图层的不透明度。请求体在求解接口的三个字段外，
额外携带 `order`（用户确认的底 → 顶顺序，**必须恰好包含全部图层 ID 各一次**，
且满足 `relations` 先后关系）与 `tuneIds`（**1～2 个**待调图层 ID，不可重复、
必须存在；其余图层保留原 `opacity`）：

```bash
curl -s http://localhost:8000/api/infer-opacity \
  -H 'Content-Type: application/json' \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" },
      { "background": "#000000", "target": "#bc0089" }
    ],
    "order": ["R", "B"],
    "tuneIds": ["R", "B"]
  }'
```

成功返回（`tune` 按 ID 字典序排列）：

```json
{
  "order": ["R", "B"],
  "orderIndexes": [0, 1],
  "tune": [
    { "id": "B", "originalOpacity": 0.5, "suggestedOpacity": 0.25 },
    { "id": "R", "originalOpacity": 0.5, "suggestedOpacity": 0.67 }
  ],
  "beforeTotalSse": 7902.30249,
  "afterTotalSse": 1.42558,
  "combinationsChecked": 10201,
  "samples": [
    {
      "index": 0,
      "background": "#ffffff",
      "target": "#e189bc",
      "before": { "predictedHex": "#ff7f7f", "predictedRgb": [255.0, 127.5, 127.5], "sse": 5234.12 },
      "after":  { "predictedHex": "#e288bd", "predictedRgb": [226.0, 136.0, 189.0], "sse": 0.89 }
    }
  ]
}
```

说明：

- 联合遍历待调图层 0.00～1.00、步长 0.01 的全部组合，并**额外纳入原始参数组**
  （例如原值 0.375 不在网格中，`combinationsChecked` 会为 102/10202）。
- 误差口径与求解接口完全一致：线性光合成后未取整 RGB × 255 的平方误差总和；
  同分时按 **ID 字典序排列的待调参数元组**从小到大决胜。
- `samples[].before / after` 分别给出调整前（原始不透明度）与调整后（建议值）的
  `predictedHex / predictedRgb / channelSse / sse`，可直接与 `target` 对比。
- 顺序缺漏 / 含不存在或重复 ID / 违反先后关系、`tuneIds` 数量不为 1～2、
  重复或不存在，或图层 / 样本 / 关系本身非法时，均返回 HTTP 400：

```json
{
  "errors": [
    { "scope": "order", "message": "顺序不满足先后关系：R 必须在 B 的更下方（底 → 顶方向）" },
    { "scope": "tune", "message": "待调图层 ID 重复：R" }
  ]
}
```

`scope` 新增取值 `order` / `tune`。

## 不用 Docker 的本地运行方式（可选）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

计算核心零第三方依赖，可直接 `python3 -c "from app import core; ..."` 单测。

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── core.py        # sRGB 转换 / alpha 合成 / 环检测 / 枚举择优 / 不透明度反推（纯标准库）
│   └── main.py        # FastAPI：/api/solve、/api/infer-opacity 与静态页面托管
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
└── README.md
```
