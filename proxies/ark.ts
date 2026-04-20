/**
 * 火山方舟 Responses API 代理
 * 修正 Codex → 火山方舟的兼容性问题
 *
 * 运行：bun proxies/ark.ts
 */

import { compose, stripTopLevel, filterTools, fillInputItemStatus } from "../lib/transforms.ts";
import { startProxy } from "../lib/server.ts";

const apiKey = process.env.ARK_API_KEY ?? "";
if (!apiKey) {
  console.error("❌ 请先设置环境变量 ARK_API_KEY");
  process.exit(1);
}

startProxy({
  port: parseInt(process.env.ARK_PORT ?? "4000"),
  targetBaseUrl: process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
  apiKey,
  transform: compose(
    // Codex 发出但火山不认识的顶层字段
    stripTopLevel(["client_metadata", "service_tier", "store", "metadata"]),
    // web_search 故意不放行——Codex 格式里带有火山不认识的 external_web_access 字段
    filterTools(["function", "code_interpreter", "retrieval"]),
    // Codex 已知 bug：多轮对话历史 item 缺少 status 字段
    fillInputItemStatus(),
  ),
});
