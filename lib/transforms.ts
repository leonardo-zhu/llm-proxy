export type Body = Record<string, unknown>;
export type Transform = (body: Body) => Body;

/** 剥掉顶层黑名单字段 */
export function stripTopLevel(blocklist: string[]): Transform {
  const set = new Set(blocklist);
  return (body) => {
    const result = { ...body };
    const stripped: string[] = [];
    for (const key of set) {
      if (key in result) {
        stripped.push(key);
        delete result[key];
      }
    }
    if (stripped.length > 0) console.log(`[proxy] stripped: ${stripped.join(", ")}`);
    return result;
  };
}

/** 过滤掉不支持的 tool type，全部被过滤时同时移除 tool_choice */
export function filterTools(allowedTypes: string[]): Transform {
  const allowed = new Set(allowedTypes);
  return (body) => {
    const tools = body.tools;
    if (!Array.isArray(tools) || tools.length === 0) return body;

    const filtered = tools.filter(
      (t): t is Record<string, string> =>
        typeof t === "object" && t !== null && allowed.has((t as Record<string, string>).type)
    );
    const removed = tools.length - filtered.length;
    if (removed > 0) console.log(`[proxy] stripped ${removed} unsupported tool(s)`);

    const result = { ...body };
    if (filtered.length > 0) {
      result.tools = filtered;
    } else {
      delete result.tools;
      delete result.tool_choice;
    }
    return result;
  };
}

/**
 * 补上 Responses API input item 缺少的 status 字段
 * Codex 已知 bug：多轮对话历史 item 缺少该字段，严格遵守 spec 的服务端会报 MissingParameter
 */
export function fillInputItemStatus(defaultStatus = "completed"): Transform {
  return (body) => {
    const input = body.input;
    if (!Array.isArray(input)) return body;
    return {
      ...body,
      input: input.map((item) => {
        if (typeof item !== "object" || item === null || "status" in (item as object))
          return item;
        return { ...(item as Record<string, unknown>), status: defaultStatus };
      }),
    };
  };
}

/**
 * content parts → text string（保留多模态时返回 array）
 * Responses API: [{type:"input_text"|"output_text"|"text", text:"..."}, ...]
 * Chat API:      "..." (纯文本) 或 [{type:"text",text:"..."},{type:"image_url",...}] (多模态)
 */
function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const TEXT_TYPES = new Set(["text", "input_text", "output_text"]);
  const allText = content.every(
    (p): p is Record<string, unknown> =>
      typeof p === "object" && p !== null && TEXT_TYPES.has((p as Record<string, unknown>).type as string),
  );
  // 全是文本 → flatten 成 string
  if (allText) {
    return content.map((p) => (p as Record<string, unknown>).text ?? "").join("");
  }
  // 含 image 等非文本 → 保留 array，转成 Chat API 的 content part 格式
  return content.map((p) => {
    if (typeof p !== "object" || p === null) return p;
    const part = p as Record<string, unknown>;
    if (TEXT_TYPES.has(part.type as string)) {
      return { type: "text", text: part.text ?? "" };
    }
    // image_url, input_audio 等直接透传
    return part;
  });
}

/**
 * Responses API 格式 → Chat Completions 格式
 *
 * 差异处理：
 * - input (string | array) → messages[]
 * - role "developer" → "system"
 * - content array of parts → string（纯文本）或 array（多模态）
 * - type "function_call" item → assistant message with tool_calls
 * - type "function_call_output" item → tool role message
 * - instructions 顶层字段 → 插入 system message
 * - tools: {type,name,description,parameters} → {type,function:{name,description,parameters}}
 * - max_output_tokens → max_tokens
 * - text.format → response_format
 */
export function responsesToChat(): Transform {
  return (body) => {
    const { input, instructions, tools, max_output_tokens, text, ...rest } =
      body as Body & { input?: unknown[] | string; instructions?: string; tools?: unknown[]; max_output_tokens?: number; text?: Record<string, unknown> };

    const result: Body = { ...rest };

    // max_output_tokens → max_tokens
    if (max_output_tokens != null) result.max_tokens = max_output_tokens;

    // text.format → response_format
    if (text && typeof text === "object") {
      const format = (text as Record<string, unknown>).format;
      if (format && typeof format === "object") {
        const fmt = format as Record<string, unknown>;
        if (fmt.type === "json_schema") {
          result.response_format = { type: "json_schema", json_schema: fmt };
        }
        // type:"text" 不需要设置 response_format
      }
    }

    // tools 格式转换
    if (Array.isArray(tools) && tools.length > 0) {
      result.tools = tools.map((t) => {
        if (typeof t !== "object" || t === null) return t;
        const { type, name, description, parameters } = t as Record<string, unknown>;
        if (type === "function") {
          return { type: "function", function: { name, description, parameters } };
        }
        return t;
      });
    }

    // input: string → array
    let inputItems: unknown[];
    if (typeof input === "string") {
      inputItems = [{ role: "user", content: input }];
    } else if (Array.isArray(input)) {
      inputItems = input;
    } else {
      return result;
    }

    const messages: unknown[] = [];
    const systemParts: string[] = [];

    // instructions → 收集为 system
    if (instructions) {
      systemParts.push(instructions);
    }

    for (const item of inputItems) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;

      if (it.type === "function_call") {
        messages.push({
          role: "assistant",
          tool_calls: [{
            id: it.call_id ?? it.id,
            type: "function",
            function: { name: it.name, arguments: it.arguments },
          }],
        });
      } else if (it.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: it.call_id,
          content: typeof it.output === "string" ? it.output : JSON.stringify(it.output),
        });
      } else if (it.type === "message" || it.role != null) {
        const role = it.role === "developer" ? "system" : it.role;
        const content = normalizeContent(it.content);
        if (content !== "" && content != null) {
          // system 消息合并成一条（MiniMax 等后端不支持多条 system）
          if (role === "system") {
            systemParts.push(typeof content === "string" ? content : JSON.stringify(content));
          } else {
            messages.push({ role, content });
          }
        }
      }
    }

    // 合并 system 消息放在最前面
    if (systemParts.length > 0) {
      messages.unshift({ role: "system", content: systemParts.join("\n\n") });
    }

    result.messages = messages;
    return result;
  };
}

/**
/** 从 content 中提取 `<think>` 推理标签，返回 {reasoning, visible} */
function extractThinkTags(content: string): { reasoning: string | null; visible: string } {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (!thinkMatch) return { reasoning: null, visible: content };
  const reasoning = thinkMatch[1].trim();
  // 移除 think 标签及其前后的多余空行
  const visible = content.replace(/<think>[\s\S]*?<\/think>\n?/, "").trim();
  return { reasoning, visible };
}

/** Chat Completions 格式 → Responses API 格式（非流式）
 *
 * - choices[0].message.content → output[] message item
 * - choices[0].message.tool_calls → output[] function_call items
 * - usage 映射
 * - id 格式转换
 */
export function chatToResponses(): Transform {
  return (body) => {
    const chat = body as Record<string, unknown>;
    const choices = chat.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const usage = chat.usage as Record<string, unknown> | undefined;

    // id: chatcmpl-xxx → resp-xxx
    let respId = String(chat.id ?? "");
    if (respId.startsWith("chatcmpl-")) {
      respId = "resp-" + respId.slice("chatcmpl-".length);
    } else if (!respId.startsWith("resp-")) {
      respId = "resp-" + respId;
    }

    const output: Record<string, unknown>[] = [];
    let msgIdx = 0;
    let fcIdx = 0;

    if (message) {
      // content → message item
      const content = message.content;
      if (content != null && content !== "") {
        const contentText = typeof content === "string" ? content : JSON.stringify(content);
        output.push({
          id: `msg-${respId}-${msgIdx++}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: contentText }],
        });
      }

      // tool_calls → function_call items
      const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const fn = tc.function as Record<string, unknown> | undefined;
          output.push({
            id: `fc-${respId}-${fcIdx++}`,
            type: "function_call",
            status: "completed",
            call_id: tc.id,
            name: fn?.name ?? "",
            arguments: fn?.arguments ?? "{}",
          });
        }
      }
    }

    // finish_reason → status
    const finishReason = choice?.finish_reason as string | undefined;
    let status = "completed";
    if (finishReason === "length") status = "incomplete";

    // usage 映射
    let respUsage: Record<string, unknown> | undefined;
    if (usage) {
      respUsage = {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      };
    }

    return {
      id: respId,
      object: "response",
      created_at: chat.created ?? Math.floor(Date.now() / 1000),
      model: chat.model ?? "",
      status,
      output,
      ...(respUsage ? { usage: respUsage } : {}),
    };
  };
}

/**
 * MiniMax 特有：从 Responses API output 中提取 think 推理标签为独立 reasoning item
 * 作为独立 transform 使用：compose(chatToResponses(), extractMiniMaxThinkTags())
 */
export function extractMiniMaxThinkTags(): Transform {
  return (body) => {
    const output = body.output as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(output)) return body;

    const newOutput: Record<string, unknown>[] = [];
    for (const item of output) {
      if (item.type !== "message") {
        newOutput.push(item);
        continue;
      }
      const content = item.content as Array<Record<string, unknown>> | undefined;
      const textPart = content?.find(
        (p) => p.type === "output_text" || p.type === "text"
      );
      const text = textPart?.text as string | undefined;
      if (!text) {
        newOutput.push(item);
        continue;
      }
      const { reasoning, visible } = extractThinkTags(text);
      if (reasoning) {
        newOutput.push({
          id: `rsn-${String(item.id ?? "").replace(/^msg-/, "")}`,
          type: "reasoning",
          status: "completed",
          content: reasoning,
        });
      }
      if (visible) {
        newOutput.push({
          ...item,
          content: [{ type: "output_text", text: visible }],
        });
      }
    }

    return { ...body, output: newOutput };
  };
}

/**
 * Chat Completions SSE stream → Responses API SSE stream
 * 用 TransformStream 实现，pipeThrough 到 fetch response body
 */
export function createChatToResponsesSSETransformer(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 状态
  let responseId = "";
  let model = "";
  let createdAt = 0;
  let buffer = "";
  let outputIndex = 0;
  let inToolCalls = false;
  let inThinkTag = false;        // 是否在 `<think>` 标签内（用于 strip）

  // 追踪并行 tool_calls: index → {id, name, arguments}
  const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const completedItems: Record<string, unknown>[] = [];

  // tool_call index → output_index 映射（修正 bug：每个 tool_call 使用固定 output_index）
  const tcOutputIndex = new Map<number, number>();
  let tcOutputIdxCounter = 0;

  // ID 生成
  let msgCounter = 0;
  let fcCounter = 0;
  const genMsgId = () => `msg-${responseId}-${msgCounter++}`;
  const genFcId = () => `fc-${responseId}-${fcCounter++}`;

  // 当前 message item 状态
  let currentMsgId: string | null = null;
  let currentMsgContent = "";
  let msgContentEmitted = false;

  function emitEvent(event: string, data: object): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function startMessageIfNeeded(): string {
    let out = "";
    if (currentMsgId === null) {
      currentMsgId = genMsgId();
      currentMsgContent = "";
      msgContentEmitted = false;
      out += emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex++,
        item: { id: currentMsgId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
    }
    return out;
  }

  function closeMessageIfNeeded(): string {
    let out = "";
    if (currentMsgId !== null) {
      if (msgContentEmitted) {
        out += emitEvent("response.content_part.done", {
          type: "response.content_part.done",
          item_id: currentMsgId,
          output_index: outputIndex - 1,
          content_index: 0,
          part: { type: "output_text", text: currentMsgContent },
        });
      }
      out += emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex - 1,
        item: {
          id: currentMsgId, type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: currentMsgContent }],
        },
      });
      completedItems.push({
        id: currentMsgId, type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: currentMsgContent }],
      });
      currentMsgId = null;
    }
    return out;
  }

  // `<think>` 标签检测状态
  const THINK_OPEN = "<think>";
  const THINK_CLOSE = "</think>";
  let pendingTag: string | null = null;

  /** 发射可见内容的 content_part delta */
  function emitVisibleDelta(vt: string): string {
    let e = "";
    e += startMessageIfNeeded();
    if (!msgContentEmitted) {
      e += emitEvent("response.content_part.added", {
        type: "response.content_part.added",
        item_id: currentMsgId,
        output_index: outputIndex - 1,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
      msgContentEmitted = true;
    }
    currentMsgContent += vt;
    e += emitEvent("response.content_part.delta", {
      type: "response.content_part.delta",
      item_id: currentMsgId,
      output_index: outputIndex - 1,
      content_index: 0,
      delta: vt,
    });
    return e;
  }

  /** 处理 content delta，strip `<think>` 标签，只发 visible content */
  function processContentWithThink(text: string): string {
    let out = "";
    let content = (pendingTag ?? "") + text;
    pendingTag = null;

    while (content.length > 0) {
      if (inThinkTag) {
        // 在 `<think>` 内 — 丢弃，找 `
        const closeIdx = content.indexOf("</think>");
        if (closeIdx !== -1) {
          inThinkTag = false;
          content = content.slice(closeIdx + THINK_CLOSE.length);
        } else {
          // 可能 `</think>` 被拆包 — 检查结尾
          let matched = false;
          for (let i = 1; i < THINK_CLOSE.length; i++) {
            if (content.endsWith(THINK_CLOSE.slice(0, i))) {
              pendingTag = content.slice(-i);
              matched = true;
              break;
            }
          }
          content = "";
        }
      } else {
        const openIdx = content.indexOf("<think>");
        if (openIdx !== -1) {
          const visible = content.slice(0, openIdx);
          if (visible.length > 0) out += emitVisibleDelta(visible);
          inThinkTag = true;
          content = content.slice(openIdx + THINK_OPEN.length);
        } else {
          // 检查是否以 `<think>` 前缀结尾
          let matched = false;
          for (let i = 1; i < THINK_OPEN.length; i++) {
            if (content.endsWith(THINK_OPEN.slice(0, i))) {
              const safe = content.slice(0, -i);
              if (safe.length > 0) out += emitVisibleDelta(safe);
              pendingTag = content.slice(-i);
              matched = true;
              break;
            }
          }
          if (!matched) out += emitVisibleDelta(content);
          content = "";
        }
      }
    }
    return out;
  }

  function processChunk(json: Record<string, unknown>): string {
    let out = "";

    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const finishReason = choice?.finish_reason as string | null | undefined;

    // 首个 chunk：提取元信息 + 发 response.created
    if (!responseId) {
      responseId = String(json.id ?? "");
      if (responseId.startsWith("chatcmpl-")) {
        responseId = "resp-" + responseId.slice("chatcmpl-".length);
      } else if (!responseId.startsWith("resp-")) {
        responseId = "resp-" + responseId;
      }
      model = String(json.model ?? "");
      createdAt = (json.created as number) ?? Math.floor(Date.now() / 1000);

      out += emitEvent("response.created", {
        type: "response.created",
        response: {
          id: responseId, object: "response", created_at: createdAt,
          model, status: "in_progress", output: [],
        },
      });
    }

    if (!delta) return out;

    // 处理 content delta（含 `<think>` 推理标签处理）
    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += processContentWithThink(delta.content);
    }

    // 处理 tool_calls delta
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // 切换到 tool_calls 阶段：先关闭 message
      if (!inToolCalls) {
        inToolCalls = true;
        out += closeMessageIfNeeded();
      }

      for (const tc of toolCalls) {
        const idx = tc.index as number;
        const existing = pendingToolCalls.get(idx);

        if (!existing) {
          // 新的 tool_call
          const fn = tc.function as Record<string, unknown> | undefined;
          const fcId = genFcId();
          const tcId = String(tc.id ?? fcId);
          const name = String(fn?.name ?? "");
          const args = String(fn?.arguments ?? "");

          // 分配固定 output_index
          const tcOutIdx = tcOutputIdxCounter++;
          tcOutputIndex.set(idx, tcOutIdx);
          pendingToolCalls.set(idx, { id: tcId, name, arguments: args });

          out += emitEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: tcOutIdx,
            item: { id: fcId, type: "function_call", status: "in_progress", call_id: tcId, name, arguments: "" },
          });

          if (args.length > 0) {
            out += emitEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: fcId,
              output_index: tcOutIdx,
              delta: args,
            });
          }
        } else {
          // 追加 arguments 到已有的 tool_call
          const fn = tc.function as Record<string, unknown> | undefined;
          const args = String(fn?.arguments ?? "");
          if (args.length > 0) {
            existing.arguments += args;
            const tcOutIdx = tcOutputIndex.get(idx) ?? 0;
            out += emitEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: existing.id,
              output_index: tcOutIdx,
              delta: args,
            });
          }
        }
      }
    }

    // 处理 finish_reason
    if (finishReason != null) {
      // 关闭所有未完成的 item
      out += closeMessageIfNeeded();

      // 关闭所有 pending tool_calls
      for (const [idx, tc] of pendingToolCalls) {
        const fcId = tc.id;
        const tcOutIdx = tcOutputIndex.get(idx) ?? idx;
        out += emitEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          output_index: tcOutIdx,
          item: { id: fcId, type: "function_call", status: "completed", call_id: tc.id, name: tc.name, arguments: tc.arguments },
        });
        out += emitEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: tcOutIdx,
          item: { id: fcId, type: "function_call", status: "completed", call_id: tc.id, name: tc.name, arguments: tc.arguments },
        });
        completedItems.push({
          id: fcId, type: "function_call", status: "completed", call_id: tc.id, name: tc.name, arguments: tc.arguments,
        });
      }
      pendingToolCalls.clear();

      // usage
      const usage = json.usage as Record<string, unknown> | undefined;
      const respUsage = usage ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

      const status = finishReason === "length" ? "incomplete" : "completed";

      out += emitEvent("response.completed", {
        type: "response.completed",
        response: {
          id: responseId, object: "response", created_at: createdAt,
          model, status, output: completedItems, usage: respUsage,
        },
      });

      out += "event: done\ndata: [DONE]\n\n";
    }

    return out;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") {
          // 如果还没收到 finish_reason，强制 close
          const flush = processChunk({ choices: [{ delta: {}, finish_reason: "stop" }] });
          if (flush) controller.enqueue(encoder.encode(flush));
          return;
        }
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const out = processChunk(json);
            if (out) controller.enqueue(encoder.encode(out));
          } catch {
            // skip malformed JSON
          }
        }
      }
    },
    flush(controller) {
      // 处理 buffer 中剩余数据
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const out = processChunk(json);
            if (out) controller.enqueue(encoder.encode(out));
          } catch {}
        }
      }
      // 确保 stream 正常关闭
    },
  });
}

/** 把多个变换函数串联成一个 */
export function compose(...transforms: Transform[]): Transform {
  return (body) => transforms.reduce((b, fn) => fn(b), body);
}
