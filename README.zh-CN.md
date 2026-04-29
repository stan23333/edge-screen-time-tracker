# Web Screen Time Tracker

中文 | [English](README.md)

Web Screen Time Tracker 是一个 Microsoft Edge / Chromium Manifest V3 浏览器插件，用来记录浏览器注意力、页面访问时间线、AI 页面摘要和更高层级的行为分析报告。

它面向把浏览器当作日常工作台的人：阅读、搜索、写代码、学习、对比资料、聊天和做决策。这个插件不只是统计“浏览器开了多久”，而是把真实的访问时间线、页面内容摘要和长期行为报告保存下来，形成一个本地优先的个人浏览器记忆系统。

## 截图

每个主要页面展示一张代表截图。Analysis 报告会在浏览器内直接进行 Markdown 在线渲染，支持标题、列表、表格、行内代码和强调样式。更多截图规范见 [`docs/SCREENSHOTS.md`](docs/SCREENSHOTS.md)。

<table>
  <tr>
    <td width="38%" valign="top">
      <strong>Popup</strong><br>
      <img src="docs/screenshots/popup.png" alt="Popup 截图" width="320" />
    </td>
    <td width="62%" valign="top">
      <strong>Dashboard</strong><br>
      <img src="docs/screenshots/dashboard.jpeg" alt="Dashboard 截图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Records</strong><br>
      <img src="docs/screenshots/records.jpeg" alt="Records 截图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>Analysis with Markdown Preview</strong><br>
      <img src="docs/screenshots/analysis.jpeg" alt="带 Markdown 渲染报告的 Analysis 截图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Logs</strong><br>
      <img src="docs/screenshots/logs.jpeg" alt="Logs 截图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>Settings</strong><br>
      <img src="docs/screenshots/settings.jpeg" alt="Settings 截图" width="100%" />
    </td>
  </tr>
</table>

## 核心功能

- 以 active usage 为核心的浏览器使用统计。
- 记录页面 open context，用来理解页面是否长期作为后台上下文存在。
- 保存访问时间线，包括 URL、标题、打开/关闭时间、active intervals 和摘要状态。
- Popup 快速查看今日状态。
- Dashboard 展示 active share、open/active 对比、热力图和站点详情。
- Records 查看访问记录、Summary JSON、模型状态和 token usage。
- Settings 配置模型供应商、提示词、API 测试、忽略域名、本地归档、WebDAV 和导出。
- Analysis 生成日/周/月行为报告，支持浏览器内 Markdown 在线渲染、Evidence、Trend 和 Frequent themes。
- 通过 OpenAI-compatible chat completions API 自动生成页面摘要。
- 对 DOM 文本抽取失败的 blocked 页面支持截图 fallback。
- 支持本地归档 records 和 analysis reports，并可选镜像备份到 WebDAV。
- 支持完整本地 JSON 导出。

## Active Usage 与 Open Context

**Active usage** 是核心注意力指标。只有满足这些条件才计入：

- 当前 tab 被选中
- 浏览器窗口处于前台聚焦
- 设备没有锁屏
- 页面是普通 `http` 或 `https` URL
- 域名没有被忽略

**Open context** 表示页面在浏览器中处于打开状态，但不代表用户正在关注它。它适合用来理解单个页面或单个网站的上下文，但不适合作为总体使用时长，因为多个标签页可以同时打开。

插件会避免把睡眠、关机、浏览器长时间挂起期间的墙钟时间计入 active 或 open。

## 页面摘要流程

自动摘要是非阻塞队列，不会阻塞时间统计：

1. 普通网页加载完成。
2. 插件创建 `pending` 摘要记录。
3. 后台队列短暂等待动态内容渲染。
4. 优先尝试 DOM 文本抽取。
5. 文本抽取成功时，将页面 metadata 和正文文本发送给 summary model。
6. 如果文本抽取被 blocked，且用户启用了截图 fallback，则可把可见页面截图发送给支持视觉输入的 summary model。
7. 保存模型原始输出和标准化后的 structured JSON。
8. 如果供应商返回 `usage`，保存 token usage。

默认结构化摘要格式：

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

## Blocked 页面与截图摘要

ChatGPT 等 AI 聊天应用或安全策略较强的网站，可能会阻止 `chrome.scripting.executeScript` 读取 DOM 文本。这不是 API key 问题，也不一定是模型问题，而是浏览器上下文读取被页面或浏览器限制了。

启用截图 fallback 后：

- 仍然优先尝试 DOM 文本抽取。
- 只有在 blocked 或正文过少时才尝试截图。
- 截图会发送给配置的、支持视觉输入的 summary model。
- 请求成功后，截图不会作为长期本地文件保留。
- 通常需要目标页面处于可见状态，截图才可能成功。
- 可以在 Settings 中限制允许截图 fallback 的域名。

这个模式要求 summary model 支持图片输入。例如通过 OpenAI-compatible 供应商暴露的 GPT-4o/4.1、Gemini、Claude 3.5/3.7、Qwen VL、LLaVA、Pixtral、InternVL、MiniCPM-V 等，具体取决于供应商实际支持。

## Analysis 报告

Analysis 页面可以生成日、周、月行为报告，输入包括：

- daily stats
- visit events
- page summaries
- 摘要 evidence level 和 capture method
- 供应商返回的 token usage

报告会在 Analysis 页面内进行 Markdown 在线渲染，支持标题、列表、代码块、行内代码、加粗和表格。Evidence 和 Trend 图表位于报告列表上方，Frequent themes 作为全宽可视化区域展示。

analysis model 可以和 summary model 分开配置，因此可以用更便宜/更快的模型做页面摘要，用更强的模型做长期行为分析。

## 安装方式

开发者模式安装：

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启 **Developer mode / 开发者模式**。
3. 选择 **Load unpacked / 加载解压缩的扩展**。
4. 选择本项目目录。

也可以通过浏览器扩展页的 **Pack extension / 打包扩展** 生成 CRX。生成的 `.pem` 私钥决定后续版本是否能保持同一个扩展 ID，务必妥善保存。不要把 `.crx`、`.pem`、API key、WebDAV 凭据或个人导出的数据提交到 GitHub。

如果要给普通用户分发，更推荐 Edge Add-ons、Chrome Web Store 或企业策略分发，而不是直接发送 CRX 文件。

## 模型配置

插件支持 OpenAI-compatible chat completions API。

内置供应商预设：

- OpenAI：`https://api.openai.com/v1`
- OpenRouter：`https://openrouter.ai/api/v1`
- SiliconFlow 中国大陆 endpoint：`https://api.siliconflow.cn/v1`
- SiliconFlow global endpoint：`https://api.siliconflow.com/v1`
- Ollama：`http://localhost:11434/v1`
- Custom endpoint

注意：

- Summary model 和 analysis model 可以独立配置。
- SiliconFlow 上部分 DeepSeek R1/V3 类模型可能不支持严格 JSON mode，插件会在必要时 fallback。
- API 测试会发送真实请求验证模型连通性。
- Analysis 请求包含更多累计数据，比 summary 测试慢是正常现象。

## 本地归档与 WebDAV 备份

本地归档是主要文件库。WebDAV 是可选远端镜像，配置后使用同一套目录结构备份一份。

默认本地归档路径在浏览器 Downloads 目录下：

```text
Downloads/browser-tracker/
```

归档结构：

```text
browser-tracker/records/YYYY/MM/YYYY-MM-DD.json
browser-tracker/analysis/YYYY/MM/YYYY-MM-DD_day_HHMMSS_reportid.md
browser-tracker/analysis/YYYY/MM/YYYY-MM-DD_to_YYYY-MM-DD_week_HHMMSS_reportid.md
browser-tracker/analysis/YYYY/MM/YYYY-MM-DD_to_YYYY-MM-DD_month_HHMMSS_reportid.md
```

每日记录文件包含 daily stats、visit events、page summaries、匹配的 analysis report 元数据、timezone、schema version、export timestamp 和去敏后的 settings。分析文件保存为 Markdown 报告。

本地归档测试会写入一个很小的 nonce 文件。WebDAV 测试会执行真实的 `PUT`、`GET`、`DELETE` nonce 请求。

## 权限说明

插件需要较多权限，因为它要跨网站追踪 tab 状态，并在用户配置后进行页面摘要：

- `tabs`：读取 tab URL/title，并追踪 active tab 变化。
- `storage`：保存本地统计、访问记录、摘要、设置和分析报告。
- `idle`：避免把锁屏或空闲时间计入 active browsing。
- `alarms`：执行周期 checkpoint 和后台队列。
- `scripting`：在允许的页面中抽取 metadata 和 DOM 文本。
- `activeTab`：在用户交互后访问当前活动页面。
- `contextMenus`：提供右键忽略网站操作。
- `notifications`：提示截图 fallback 的一次性说明或重要状态。
- `debugger`：当标准截图 API 被 blocked 时，捕获可见页面用于截图摘要。
- `<all_urls>`：支持跨用户访问的网站进行统计和可选摘要。

`debugger` 权限只用于 blocked 页面截图 fallback，不用于远程调试用户行为。

## 隐私说明

默认情况下，数据保存在本地 `chrome.storage.local`。

只有用户配置相关功能时，数据才会发送到外部服务：

- 页面文本或截图证据会在摘要运行时发送给配置的 summary model。
- 聚合统计、访问记录和页面摘要会在分析运行时发送给配置的 analysis model。
- 本地归档文件会写入用户配置的归档目录，或浏览器 Downloads fallback。
- 归档镜像只会上传到用户配置的 WebDAV endpoint。
- JSON 导出可能包含私密浏览历史和页面摘要。

API key 和 WebDAV 凭据保存在本地扩展存储中。导出的数据请视为私密数据处理。

## 当前限制

- 截图 fallback 需要页面可见，并且 summary model 支持视觉输入。
- 浏览器内部页面、扩展页面等不能被摘要。
- 不同供应商行为不同，不是所有 OpenAI-compatible endpoint 都支持 JSON mode、图片输入或 token usage。
- 成本取决于模型价格、捕获内容长度、截图使用频率和摘要触发数量。
- 未来 schema 变化还需要更正式的 migration 工具。

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
│   ├── screenshots/
│   └── SCREENSHOTS.md
├── README.md
└── README.zh-CN.md
```
