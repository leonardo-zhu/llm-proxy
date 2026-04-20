/**
 * 火山方舟代理（单端口双路由）
 *
 *   /ark/*        直接转发 Responses API，修正 Codex 兼容性问题
 *   /ark/chat/*   Chat Completions → Responses API 转换，再修正兼容性
 *
 * 运行：bun proxies/ark.ts
 */

import {
  compose,
  stripTopLevel,
  filterTools,
  fillInputItemStatus,
  chatToResponses,
} from "../lib/transforms.ts";
import { startProxy } from "../lib/server.ts";

const apiKey = process.env.ARK_API_KEY ?? "";
if (!apiKey) {
  console.error("❌ 请先设置环境变量 ARK_API_KEY");
  process.exit(1);
}

const arkBase = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";

// Codex → 火山方舟的通用修复
const arkFixes = compose(
  stripTopLevel(["client_metadata", "service_tier", "store", "metadata"]),
  filterTools(["function", "code_interpreter", "retrieval"]),
  fillInputItemStatus(),
);

startProxy({
  port: parseInt(process.env.ARK_PORT ?? "4000"),
  routes: [
    {
      // 必须放在 /ark 前面，前缀越长优先级越高（server.ts 已处理）
      prefix: "/ark/chat",
      targetBaseUrl: arkBase,
      apiKey,
      transform: compose(chatToResponses(), arkFixes),
    },
    {
      prefix: "/ark",
      targetBaseUrl: arkBase,
      apiKey,
      transform: arkFixes,
    },
  ],
});
