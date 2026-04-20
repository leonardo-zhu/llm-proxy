import { compose, stripTopLevel, filterTools, fillInputItemStatus, responsesToChat, chatToResponses, createChatToResponsesSSETransformer } from "../lib/transforms.ts";
import { requireEnv } from "../lib/server.ts";
import type { ProxyRoute } from "../lib/server.ts";

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
  responseTransform: chatToResponses(),
  streamTransformer: createChatToResponsesSSETransformer,
};
