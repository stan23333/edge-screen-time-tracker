# Web Screen Time Tracker

中文 | [English](README.md)

<img src="docs/assets/logo.png" alt="Web Screen Time Tracker Logo" style="zoom:25%;" />

Web Screen Time Tracker 是一个 Microsoft Edge / Chromium Manifest V3 浏览器插件，用来记录浏览器活动、页面访问时间线、页面摘要，以及 AI 行为分析报告。

这个项目由用户与 Codex / GPT-5.5 通过多轮协作共同设计和开发。Codex / GPT-5.5 不是插件运行时依赖，而是本项目设计、实现、审查和迭代过程中的工程协作工具。

## 为什么做这个软件

浏览器很像电脑的“第二系统”。很多人的阅读、搜索、学习、工作、聊天、比较、决策，都发生在浏览器标签页里。普通 screen time 工具只能告诉你用了多久，但回答不了更重要的问题：

- 我今天到底看了什么？
- 我什么时候阅读、搜索、工作、分心、反复查看某些内容？
- 哪些网站真正获得了我的注意力？
- 哪些内容主题会跨天、跨周、跨月重复出现？
- 当数据积累足够多之后，更强的模型能否帮我理解自己的行为模式？

所以这个项目虽然从“浏览器使用时长统计”开始，但目标不是只做 screen time tracker，而是做一个个人浏览器记忆与行为分析系统。时间只是一个维度，更重要的是访问时间线、页面内容摘要、主题重复、长期行为模式。

## 截图位置

为了保持 README 可读性，这里只直接展示 Logo、Popup 和 Dashboard。更多页面截图放在 `docs/screenshots/` 目录中。

### Popup



<img src="docs/screenshots/popup2.png" alt="Popup 详情截图" style="zoom:50%;" />

### Dashboard

<img src="docs/screenshots/dashboard.jpeg" alt="Dashboard 截图" style="zoom:50%;" />

其它截图：

- Records：`docs/screenshots/records.jpeg`
- Settings：`docs/screenshots/settings.jpeg`

## 核心概念

### Active Usage

Active usage 是核心注意力指标。满足以下条件时才会计入：

- 当前 tab 被选中
- 浏览器窗口处于前台聚焦
- 设备没有锁屏
- 页面是普通 `http` 或 `https` URL
- 网站没有被忽略

Active time 用于总时长、排行、占比和 Popup/Dashboard 的主要解释。

### Open Context

Open context 表示页面或网站处于打开状态，但不代表用户正在关注它。

它只适合作为单个页面或单个网站的上下文指标。例如某网站打开了 2 小时，但 active 只有 8 分钟，这说明它大部分时间只是挂在后台。把所有 open time 做总体求和通常会误导，因为多个标签页可以同时打开。因此 UI 中不再把 open 作为主要总量，只保留在单站点/单页面对比里。

### Visit Events

`visitEvents` 是原始访问时间线，是更长期分析的基础。它记录：

- domain
- URL
- title
- 打开/关闭时间戳
- active intervals
- summary status
- summary ID

聚合图表可以改变，但原始访问时间线是事实来源。

### Page Summaries

`pageSummaries` 保存模型生成的页面摘要。它们被设计成可导出、可积累、可在未来交给更强模型做长期分析的数据。

### Analysis Reports

`analysisReports` 保存日、周、月级别的行为分析报告。分析输入来自浏览统计、访问时间线和页面摘要。

## 已实现功能

- Microsoft Edge / Chromium Manifest V3 插件
- active-first Popup 今日概览
- 当前页面 active 占今日 active 的比例
- Dashboard active-first 可视化
- 单网站 open/active 条形对比
- Records 页面：访问记录、Summary JSON、LLM usage、token usage
- Settings 页面：摘要模型、分析模型、提示词、忽略域名、WebDAV
- Analysis 页面：日/周/月行为分析
- 自动页面摘要队列
- OpenAI-compatible API 支持
- OpenAI、OpenRouter、SiliconFlow、Ollama、自定义 endpoint 预设
- SiliconFlow 兼容处理，包括 DeepSeek R1/V3 类模型的 JSON mode fallback
- Summary API、Analysis API、WebDAV 的真实连通性测试
- 供应商返回 `usage` 时记录 token usage
- 完整 JSON 导出
- WebDAV 按周归档备份
- 右键菜单忽略网站
- 页面内 ignored domains 管理
- 使用 `chrome.storage.local` 本地存储
- 锁屏状态检测
- 按系统时区分组日期

## 页面说明

### Popup

Popup 适合快速查看当前状态：

- 今日 active 总时长
- 当前页面 active 时间
- 当前页面 active 占今日 active 的比例
- 当前页面 open/active 对比
- Top active sites
- 快速 ignore
- 跳转 Dashboard

### Dashboard

Dashboard 是主要使用情况可视化页面：

- active 总时长
- top active site share
- active 排名的网站列表
- 每个网站的 open/active 对比条
- active/open heatmap
- 选中网站详情

Open time 在这里仍然显示，因为它对单个网站的上下文对比有用。

### Records

Records 是数据检查页面：

- 按时间范围查看网站统计
- 查看 visit list 和时间戳
- 查看 Summary JSON
- 查看 LLM 请求状态
- 查看摘要/分析 token usage
- 查看 pending/capturing/summarizing/done/error/skipped 状态

默认情况下，Summary JSON 面板显示最新成功摘要。如果用户点击某条 visit，右侧会固定显示点击的那条记录，即使它是失败、跳过、pending 或 summarizing，也不会被自动刷新跳走。

### Settings

Settings 包含：

- summary model 配置
- analysis model 配置
- 可编辑提示词
- provider presets
- 真实 API 测试
- WebDAV 配置和测试
- ignored domains
- JSON 导出
- 当前页面手动触发摘要
- 当前周备份

### Analysis

Analysis 生成更高层次的行为总结：

- 最近一天
- 最近一周
- 最近一个月

摘要模型和分析模型可以分开配置，因此可以用便宜/快速模型做页面摘要，用更强模型做行为分析。

## LLM 摘要流程

自动摘要使用非阻塞队列：

1. 普通网页加载完成。
2. 插件创建 `pending` 摘要记录。
3. 后台摘要队列短暂等待，让动态内容完成渲染。
4. 插件抽取 title、meta description、headings、body text。
5. 调用 summary model，并要求固定 JSON schema。
6. 保存原始模型输出和标准化后的 structured JSON。
7. 如果供应商返回 `usage`，保存 token usage。

摘要队列与 tracking 队列分离。模型响应慢不应该阻塞 active/open 时间统计。

## 默认 Summary JSON Schema

默认提示词要求模型返回如下 JSON：

```json
{
  "summary": "string",
  "topics": ["string"],
  "contentType": "article|video|tool|search|social|docs|other",
  "intent": "string",
  "keyPoints": ["string"],
  "confidence": 0.0
}
```

字段含义：

- `summary`：页面简短总结
- `topics`：主题标签，便于后续聚合
- `contentType`：内容类型
- `intent`：推测用户访问该页面的目的
- `keyPoints`：关键点
- `confidence`：模型置信度，范围 `0.0` 到 `1.0`

标准化后的对象会保存为 `structuredSummary`。

## Summary 状态

`pageSummaries` 和 `visitEvents` 使用以下状态：

- `pending`：摘要任务已创建
- `capturing`：正在抽取页面内容
- `summarizing`：正在请求模型
- `done`：摘要成功
- `error`：模型/API/不可恢复错误
- `skipped`：页面关闭、URL 变化、域名被忽略、URL 不支持或内容抽取被阻止

`skipped` 不等于 `error`。它通常不是 API 失败，而是插件决定不摘要，或无法安全抽取页面内容。

## 存储结构

插件使用 `chrome.storage.local` 本地保存数据。

简化结构如下：

```json
{
  "dailyStats": {
    "2026-04-26": {
      "example.com": {
        "activeSeconds": 1800,
        "openSeconds": 5400
      }
    }
  },
  "visitEvents": {
    "2026-04-26": [
      {
        "id": "uuid",
        "domain": "example.com",
        "url": "https://example.com/article",
        "title": "Example Article",
        "openedAt": 1777200000000,
        "closedAt": 1777201800000,
        "openSeconds": 1800,
        "activeSeconds": 600,
        "activeIntervals": [
          {
            "start": 1777200300000,
            "end": 1777200900000,
            "seconds": 600
          }
        ],
        "summaryId": "uuid",
        "summaryStatus": "done"
      }
    ]
  },
  "pageSummaries": {
    "2026-04-26": [
      {
        "id": "uuid",
        "createdAt": 1777201000000,
        "domain": "example.com",
        "url": "https://example.com/article",
        "title": "Example Article",
        "status": "done",
        "model": "model-name",
        "prompt": "summary prompt",
        "summary": "{\"summary\":\"...\"}",
        "structuredSummary": {
          "summary": "...",
          "topics": ["..."],
          "contentType": "article",
          "intent": "...",
          "keyPoints": ["..."],
          "confidence": 0.8
        },
        "usage": {
          "prompt_tokens": 1000,
          "completion_tokens": 200,
          "total_tokens": 1200
        },
        "error": ""
      }
    ]
  },
  "analysisReports": {
    "day": [
      {
        "id": "uuid",
        "createdAt": 1777202000000,
        "period": "day",
        "startDate": "2026-04-26",
        "endDate": "2026-04-26",
        "model": "analysis-model-name",
        "report": "...",
        "usage": {
          "total_tokens": 3000
        }
      }
    ]
  }
}
```

## WebDAV 备份

WebDAV 备份按周归档，而不是每次小变化都上传。

默认路径：

```text
browser-tracker/weeks/YYYY-Www.json
```

示例：

```text
browser-tracker/weeks/2026-W17.json
```

每个周归档包含：

- daily stats
- visit events
- page summaries
- analysis reports
- timezone
- schema version
- export timestamp
- 去敏后的 settings

当日/周/月分析成功后，如果配置了 WebDAV，插件会上传受影响的周归档。

WebDAV 测试使用真实的 `PUT`、`GET`、`DELETE` 请求，并带有 nonce 内容。绿灯表示服务器完成了一次真实写入、读取和删除循环。

## 安装方式

1. 打开 `edge://extensions`。
2. 开启开发者模式。
3. 选择 **Load unpacked / 加载解压缩的扩展**。
4. 选择本项目目录：`edge-screen-time-tracker`。

## 模型配置

插件支持 OpenAI-compatible chat completions API。

内置预设：

- OpenAI：`https://api.openai.com/v1`
- OpenRouter：`https://openrouter.ai/api/v1`
- SiliconFlow：`https://api.siliconflow.com/v1`
- Ollama：`http://localhost:11434/v1`
- 自定义 endpoint

SiliconFlow 注意事项：

- 部分 DeepSeek R1/V3 类模型不支持严格 JSON mode。
- 插件会在必要时避免或重试去掉 `response_format`。
- 模型请求失败时，尽量显示供应商返回的 error body。

## 成本说明

LLM 成本取决于：

- 模型价格
- prompt 长度
- 页面正文长度
- 自动摘要触发数量
- 供应商是否返回 token usage

真实观察样本：

- 18 个网站使用 GLM-5-Air 摘要，花费约 `¥0.1253`。

这个数字暂时不直接判断贵或便宜，但它是需要跟踪的真实样本。如果在日常/每周尺度下成本增长过快，这就会成为产品风险或 bug。

## 当前问题 / TODO

- [ ] LLM 成本优化：18 个网站 + GLM-5-Air 花费 `¥0.1253`，需要继续观察长期成本是否可接受。
- [ ] Prompt 优化：当前 prompt 可以工作，但可能偏长，可能增加成本。
- [ ] 摘要降本策略：考虑同 URL 缓存、内容变化检测、触发频率控制、低价模型预处理。
- [ ] WebDAV 真实环境长期测试：测试流程和 weekly archive 已实现，但需要更多真实 WebDAV 服务验证。
- [ ] Blocked 内容抽取：ChatGPT 等网站可能阻止 `chrome.scripting.executeScript` 抽取正文。
- [ ] 更细 token/cost 可视化：按模型、网站、日期、摘要/分析类型拆分成本。
- [ ] 数据迁移策略：未来 schema 变化需要 migration 工具和 schema version 处理。
- [ ] Prompt 质量继续迭代：提高摘要准确性，减少噪音，让长期行为分析更有用。

## 已知限制：Blocked 页面

某些页面会阻止扩展抽取内容。此时 `chrome.scripting.executeScript` 可能返回类似 `Blocked` 的错误。

这不是 API key 问题，也不一定是模型问题，而是插件无法在浏览器上下文读取页面正文。

预期处理方式：

- 访问记录仍然保存
- 摘要可能进入 `skipped` 或 `error`
- UI 显示具体原因
- 不向模型发送空内容

## 项目结构

```text
edge-screen-time-tracker/
├── manifest.json
├── background.js
├── popup/
├── dashboard/
├── records/
├── settings/
├── analysis/
├── utils/
├── assets/
├── docs/
│   ├── assets/
│   └── screenshots/
├── README.md
└── README.zh-CN.md
```

## 隐私说明

默认数据保存在本地 `chrome.storage.local`。只有在用户配置模型 API 或 WebDAV 时，数据才会发送到外部服务。

注意：

- API key 保存在本地扩展存储中。
- 页面内容只会在摘要运行时发送到配置的 summary model。
- 分析数据只会在运行分析时发送到配置的 analysis model。
- WebDAV 只会上传到用户配置的 WebDAV endpoint。
- 导出的 JSON 可能包含私密浏览历史和摘要。

不要提交真实 API key、WebDAV 密码或个人导出数据。

## Roadmap

- 更低成本的 prompt 模板和摘要模式
- 更准确的 blocked 页面分类
- provider-specific model capability profiles
- 更细的成本仪表盘
- schema migration 工具
- 更强的周/月行为模式分析
- 所有页面更统一的视觉设计
