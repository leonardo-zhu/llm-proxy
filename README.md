# LLM Proxy

OpenAI Responses API ↔ Chat Completions API 双向协议转换代理。

让只支持 Responses API 的客户端（如 Codex CLI）对接 Chat Completions 后端（如 MiniMax、火山方舟）。

## 架构

```
Codex (Responses API)
    │
    ▼  request: Responses 格式
┌───────────────────────────┐
│       Proxy Server        │
│  responsesToChat()        │  request → Chat 格式
│  chatToResponses()        │  response → Responses 格式
│  SSE stream transformer   │  流式事件转换
└───────────────────────────┘
    │
    ▼  Chat Completions
MiniMax / 火山方舟
```

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
```

需要配置的 Key（按需填，不配的后端不可用）：

- `MINIMAX_API_KEY` — MiniMax
- `ARK_API_KEY` — 火山方舟
- `NOUS_API_KEY` — NousResearch

端口硬编码为 `4000`（见 `index.ts`）。

### 2. 启动

```bash
bun run index.ts
```

代理启动在 `http://127.0.0.1:4000`。

### 3. 配置 Codex

将 base URL 设为 `http://127.0.0.1:4000/minimax`。

## 路由

| 路径 | 后端 | 说明 |
|------|------|------|
| `/minimax/*` | MiniMax | 请求/响应双向转换 + think 标签处理 |
| `/ark/*` | 火山方舟 | 请求侧 strip/fillInputItemStatus，响应透传 |
| `/nous/*` | NousResearch | 请求/响应双向转换 |

## 协议转换

### Request (Responses → Chat)

- `input` (string \| array) → `messages[]`
- `instructions` → system message（多条合并为一条）
- `developer` role → `system` role
- content parts array → string（纯文本）或 array（多模态）
- `function_call` item → assistant `tool_calls`
- `function_call_output` item → `role: "tool"` message
- tools 格式：`{type,name,...}` → `{type,function:{name,...}}`
- `max_output_tokens` → `max_tokens`
- `text.format` → `response_format`

### Response (Chat → Responses)

- `choices[0].message.content` → `output[]` message item
- `choices[0].message.tool_calls` → `output[]` function_call items
- usage 字段映射
- `<think>` 推理标签 → 独立 reasoning item（MiniMax 特有）

### Stream (SSE)

- Chat SSE delta events → Responses API SSE events
- 自动 strip `<think>` 标签（流式）
- 支持跨 chunk 的标签边界检测

## 项目结构

```
index.ts             入口，启动代理
globals.d.ts         Bun / Node 全局类型声明

lib/
  transforms.ts      协议转换函数（通用）
  server.ts          代理服务器

proxies/
  minimax.ts         MiniMax 路由 + think 标签处理（独有）
  ark.ts             火山方舟路由
  nous.ts            NousResearch 路由

docs/
  responses-chat-conversion.md   设计文档
```

## 健康检查

```bash
curl http://localhost:4000/health
```

## 调试

请求/响应详情写入 `logs/proxy-debug.log`（自动创建，已在 .gitignore 中）。
