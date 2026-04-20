/**
 * Chat Completions → Responses API 转换代理
 * 接收标准 /v1/chat/completions 请求，转换成 Responses API 格式后转发
 *
 * 运行：bun proxies/chat-to-resp.ts
 */

import type { Body, Transform } from "../lib/transforms.ts";
import { startProxy } from "../lib/server.ts";

/**
 * 把 chat completions 请求体转成 Responses API 格式
 *
 * chat:     { model, messages: [{role, content}], ... }
 * responses: { model, input: [{role, content}], ... }
 */
const chatToResponses: Transform = (body: Body): Body => {
  const { messages, ...rest } = body as { messages?: unknown[] } & Body;
  if (!Array.isArray(messages)) return body;

  return {
    ...rest,
    input: messages.map((msg) => {
      if (typeof msg !== "object" || msg === null) return msg;
      const { role, content } = msg as Record<string, unknown>;

      // system 消息在 Responses API 里用 instructions 字段表达
      if (role === "system") {
        return { type: "message", role: "user", content, status: "completed" };
      }

      return { type: "message", role, content, status: "completed" };
    }),
  };
};

const apiKey = process.env.RESP_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
if (!apiKey) {
  console.error("❌ 请先设置环境变量 RESP_API_KEY 或 OPENAI_API_KEY");
  process.exit(1);
}

startProxy({
  port: parseInt(process.env.CHAT_TO_RESP_PORT ?? "4001"),
  targetBaseUrl: process.env.RESP_BASE_URL ?? "https://api.openai.com/v1",
  apiKey,
  transform: chatToResponses,
});
