import { compose, stripTopLevel, filterTools, fillInputItemStatus, responsesToChat, chatToResponses, createChatToResponsesSSETransformer } from "../lib/transforms.ts";
import type { Body, Transform } from "../lib/transforms.ts";
import { requireEnv } from "../lib/server.ts";
import type { ProxyRoute } from "../lib/server.ts";

/** MiniMax 特有：提取 think 推理标签 */
function extractThinkTags(content: string): { reasoning: string | null; visible: string } {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (!thinkMatch) return { reasoning: null, visible: content };
  const reasoning = thinkMatch[1].trim();
  const visible = content.replace(/<think>[\s\S]*?<\/think>\n?/, "").trim();
  return { reasoning, visible };
}

/** MiniMax 特有：从 output 中提取 think 标签为独立 reasoning item */
function extractMiniMaxThinkTags(): Transform {
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

export const route: ProxyRoute = {
  prefix: "/minimax",
  targetBaseUrl: "https://api.minimax.chat/v1",
  targetPath: "/chat/completions",
  apiKey: requireEnv("MINIMAX_API_KEY"),
  transform: compose(
    stripTopLevel(["store", "metadata", "client_metadata", "service_tier", "include",
                   "prompt_cache_key", "reasoning", "parallel_tool_calls", "text"]),
    filterTools(["function"]),
    fillInputItemStatus(),
    responsesToChat(),
  ),
  responseTransform: compose(chatToResponses(), extractMiniMaxThinkTags()),
  streamTransformer: createChatToResponsesSSETransformer,
};
