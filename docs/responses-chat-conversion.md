# Responses API ↔ Chat Completions API 双向转换设计

## 1. 架构概览

```
Codex (Responses API)
    │
    ▼  request: Responses 格式
┌───────────────────────────┐
│       Proxy Server        │
│                           │
│  ┌─────────────────────┐  │
│  │  responsesToChat()  │  │  request 转换
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │
│  │  chatToResponses()  │  │  response 转换（当前缺失）
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │
│  │  SSE stream 转换    │  │  stream 转换（当前缺失）
│  └─────────────────────┘  │
└───────────────────────────┘
    │
    ▼  request: Chat 格式
MiniMax /chat/completions
    │
    ▼  response: Chat 格式
```

当前状态：只有 request 方向（左→右），response 方向（右→左）完全缺失。

## 2. 协议差异速查

| 维度 | Responses API | Chat Completions API |
|------|--------------|---------------------|
| endpoint | `/v1/responses` | `/v1/chat/completions` |
| input | `input: string \| InputItem[]` | `messages: ChatMessage[]` |
| system prompt | `instructions: string` | `messages[0].role = "system"` |
| output | `output[]` items | `choices[].message` |
| content 格式 | `[{type:"output_text",text:"..."}]` | `"hello"` (plain string) |
| tool call | `function_call` item | `message.tool_calls[]` |
| tool result | `function_call_output` item | `role:"tool"` message |
| tool 定义 | `{type,name,description,parameters}` | `{type,function:{name,description,parameters}}` |
| max tokens | `max_output_tokens` | `max_tokens` |
| token 用量 | `input_tokens / output_tokens` | `prompt_tokens / completion_tokens` |
| response id | `resp_xxx` | `chatcmpl_xxx` |
| object type | `"response"` | `"chat.completion"` |

## 3. Request 转换：Responses → Chat（完善现有）

### 3.1 input 处理

input 支持两种形态，当前代码只处理了 array：

```typescript
// input: "hello"  ← string 形态，当前被忽略
// input: [{role:"user", content:"hello"}]  ← array 形态，已处理
```

**修正：** string 形态直接转成 `[{role:"user", content: input}]`。

### 3.2 messages 构建顺序

```
1. instructions → {role:"system", content: instructions}
2. 遍历 input items：
   - {role:"developer"} → {role:"system", content}
   - {role:"user", content:[...]} → {role:"user", content: string}
   - {role:"assistant", content:[...]} → {role:"assistant", content: string}
   - {type:"function_call"} → {role:"assistant", tool_calls:[{id, type:"function", function:{name, arguments}}]}
   - {type:"function_call_output"} → {role:"tool", tool_call_id: call_id, content: output}
   - 其他 type（reasoning 等）→ 跳过
```

### 3.3 content 归一化

Responses API 的 content 是 parts array，需要提取文本：

```typescript
// [{type:"output_text", text:"hello"}] → "hello"
// [{type:"input_text", text:"hello"}] → "hello"
// [{type:"image_url", ...}] → 对于 Chat API 需保留为多模态格式
```

**注意：** Chat Completions 也支持 content array（用于多模态），如果 content 里有 image 类型，应该保留 array 格式而不是 flatten 成 string。当前代码全部 flatten，对多模态场景有损。

### 3.4 tool_choice 转换

| Responses API | Chat Completions API |
|--------------|---------------------|
| `"auto"` | `"auto"` |
| `"none"` | `"none"` |
| `"required"` | `"required"` |
| `{type:"function",function:{name:"X"}}` | `{type:"function",function:{name:"X"}}` |

格式基本一致，但 Responses API 的 `tool_choice` 可以是顶层 string `"auto"` 等，也可以是 object。需要透传。

### 3.5 response_format / text.format 转换

| Responses API | Chat Completions API |
|--------------|---------------------|
| `text: {format:{type:"text"}}` | 不需要设置 |
| `text: {format:{type:"json_schema",name,schema,strict}}` | `response_format:{type:"json_schema",json_schema:{name,schema,strict}}` |

### 3.6 字段剥离

MiniMax 不支持的字段需要 strip：
- `store`, `metadata`, `client_metadata`, `service_tier`
- `include`（Responses API 的输出控制字段）
- `prompt_cache_key`, `reasoning`, `parallel_tool_calls`
- `text`（转换后不应残留）

## 4. Response 转换：Chat → Responses（新实现）

### 4.1 非流式响应转换

Chat Completions response：
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "MiniMax-Text-01",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "tool_calls": [{
        "id": "call_xyz",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"Beijing\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

转换为 Responses API response：
```json
{
  "id": "resp_abc123",
  "object": "response",
  "created_at": 1700000000,
  "model": "MiniMax-Text-01",
  "status": "completed",
  "output": [
    {
      "id": "msg_abc123",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "Hello!"}
      ]
    },
    {
      "id": "fc_xyz",
      "type": "function_call",
      "status": "completed",
      "call_id": "call_xyz",
      "name": "get_weather",
      "arguments": "{\"city\":\"Beijing\"}"
    }
  ],
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "total_tokens": 150
  }
}
```

转换规则：

| 字段 | 规则 |
|------|------|
| `id` | `chatcmpl-` → `resp-` 前缀替换，或直接生成新 id |
| `object` | `"chat.completion"` → `"response"` |
| `created` | → `created_at`（同值） |
| `model` | 透传 |
| `status` | `finish_reason: "stop"` → `"completed"`，`"tool_calls"` → `"completed"`，`"length"` → `"incomplete"` |
| `output[]` | 从 choices[0] 构建，见下 |
| `usage` | `prompt_tokens` → `input_tokens`，`completion_tokens` → `output_tokens`，`total_tokens` 透传 |

#### output 构建逻辑

choices[0].message 转成 output items：

```
if (message.content) → output.push({
  id: "msg_<随机或从 response id 派生>",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{type: "output_text", text: message.content}]
})

if (message.tool_calls) → for each tool_call:
  output.push({
    id: "fc_<随机>",
    type: "function_call",
    status: "completed",
    call_id: tool_call.id,
    name: tool_call.function.name,
    arguments: tool_call.function.arguments
  })
```

### 4.2 流式响应转换（核心难点）

Chat Completions SSE 事件流：
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"...", "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"ci"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\":\"Beijing\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}

data: [DONE]
```

转换为 Responses API SSE 事件流：
```
event: response.created
data: {"type":"response.created","response":{"id":"resp-xxx","object":"response","created_at":1700000000,"model":"...","status":"in_progress","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_xxx","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}

event: response.content_part.delta
data: {"type":"response.content_part.delta","item_id":"msg_xxx","output_index":0,"content_index":0,"delta":"Hello"}

event: response.content_part.done
data: {"type":"response.content_part.done","item_id":"msg_xxx","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello"}}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_xxx","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_xxx","type":"function_call","status":"in_progress","call_id":"call_1","name":"get_weather","arguments":""}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_xxx","output_index":1,"delta":"{\"ci"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_xxx","output_index":1,"delta":"ty\":\"Beijing\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","output_index":1,"item":{"id":"fc_xxx","type":"function_call","status":"completed","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Beijing\"}"}}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_xxx","type":"function_call","status":"completed","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Beijing\"}"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp-xxx","object":"response","created_at":1700000000,"model":"...","status":"completed","output":[...完整 output items...],"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}

event: done
data: [DONE]
```

#### Stream 转换状态机

```
┌─────────────┐
│   IDLE      │  等待第一个 chunk
└──────┬──────┘
       │ 收到 delta.role="assistant"
       ▼
┌─────────────┐
│ IN_MESSAGE  │  正在输出 text content
│             │  - delta.content → content_part.delta
│             │  - delta.tool_calls 开始 → 结束 message，开始 tool_call
└──────┬──────┘
       │ delta.tool_calls 出现
       ▼
┌─────────────┐
│ IN_TOOL_CALL│  正在输出 function_call arguments
│             │  - 按 tool_call index 追踪当前是哪个
│             │  - delta.function.arguments → function_call_arguments.delta
│             │  - 新的 tool_call index → 结束上一个，开始新的
└──────┬──────┘
       │ finish_reason 非 null
       ▼
┌─────────────┐
│ COMPLETED   │  发送 response.completed + [DONE]
└─────────────┘
```

#### Stream 转换关键细节

1. **tool_calls 的 index 追踪**
   Chat stream 用 `index` 字段标识并行 tool_call 所属，需要维护 `Map<index, {id, name, arguments}>` 来累积。
   当新 chunk 的 index 不在 map 中 → emit `output_item.added`。
   当 stream 结束 → emit 所有未关闭 tool_call 的 `output_item.done`。

2. **content 和 tool_calls 的互斥**
   实际模型输出通常是先有 content（如果有），然后 tool_calls。但 spec 没有保证互斥。
   处理策略：当收到第一个 tool_calls delta 时，先 close 当前 message item（如果有）。

3. **usage 信息**
   Chat stream 通常在最后一个 chunk（finish_reason 非 null）附带 usage。
   Responses API 的 usage 放在 `response.completed` event 的 response 对象里。

4. **id 派生**
   - response id: `chatcmpl-xxx` → `resp-xxx`
   - message item id: `msg-<random>`
   - function_call item id: `fc-<random>`

## 5. 实现规划

### 5.1 transforms.ts 新增函数

```
chatToResponses(): Transform
  - 非流式：完整 body 转换
  - 流式：需要不同的处理路径（不能用 Transform，需要 SSE stream 处理器）

createSSETransformer(): TransformStream<Uint8Array, Uint8Array>
  - TransformStream 适配器，用于 ReadableStream pipeThrough
  - 内部维护状态机
  - 逐行解析 `data:` 和 `event:` 行
  - 按状态机 emit Responses API 格式的 SSE events
```

### 5.2 server.ts 改动

```typescript
// 当前：
const respBody = await resp.arrayBuffer();
return new Response(respBody, { ... });

// 改为：
if (resp.headers.get("content-type")?.includes("text/event-stream")) {
  // 流式：pipeThrough SSE transformer
  return new Response(resp.body!.pipeThrough(createSSETransformer(route)), {
    status: resp.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
} else {
  // 非流式：JSON body 转换
  const respBody = await resp.json();
  const transformed = route.responseTransform
    ? route.responseTransform(respBody)
    : respBody;
  return Response.json(transformed, { status: resp.status });
}
```

### 5.3 ProxyRoute 扩展

```typescript
export interface ProxyRoute {
  // ...现有字段
  responseTransform?: Transform;          // 非流式 response 转换
  streamTransformer?: StreamTransformer;  // 流式 SSE 转换
}
```

### 5.4 文件结构

```
lib/
  transforms.ts      ← 扩展：新增 chatToResponses(), SSE transformer
  server.ts          ← 扩展：支持 response 转换和 stream 转换

proxies/
  minimax.ts         ← 使用新的双向转换
  ark.ts             ← 不变（方舟支持 Responses API 原生格式）
```

## 6. 边界情况和已知坑

### 6.1 Codex 已知行为

- 多轮对话的 input items 缺少 `status` 字段 → `fillInputItemStatus` 已处理
- input 可以是纯 string → 需要处理（当前未处理）
- 期望 stream 的第一个 event 是 `response.created`

### 6.2 MiniMax 已知差异

- 返回的 `finish_reason` 值可能与 OpenAI 不完全一致（需要实测确认）
- tool_calls 的 `arguments` 是 JSON string，和 OpenAI 一致
- 可能不支持某些 `tool_choice` 模式

### 6.3 Stream 处理的健壮性

- SSE 行可能以 `\n` 或 `\r\n` 分隔
- 需要处理不完整的 chunk（TCP 拆包）
- `[DONE]` 信号必须正确传递
- 网络中断时需要合理处理（emit error 或 close stream）

### 6.4 多模态内容

- Chat API 的 content array 格式 `[{type:"text",text:"..."},{type:"image_url",...}]`
- Responses API 的 content 格式 `[{type:"output_text",text:"..."}]`
- 如果 Chat response 包含 image（少见但可能），需要适配或报错

## 7. 测试策略

### 7.1 单元测试

- `responsesToChat()`：构造各种 input 组合，验证 messages 输出
- `chatToResponses()`：构造各种 Chat response，验证 output items
- SSE transformer：用 mock stream 验证事件序列

### 7.2 集成测试

```bash
# 非流式测试
curl http://localhost:4000/minimax/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"MiniMax-Text-01","input":"hello","stream":false}'

# 流式测试
curl http://localhost:4000/minimax/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"MiniMax-Text-01","input":"hello","stream":true}'

# tool call 测试
curl http://localhost:4000/minimax/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model":"MiniMax-Text-01",
    "input":"北京天气怎么样",
    "tools":[{"type":"function","name":"get_weather","description":"查天气","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]
  }'
```

### 7.3 Codex 端到端测试

最终验证：将 Codex 的 base URL 指向 proxy，执行完整对话 + tool call 流程。
