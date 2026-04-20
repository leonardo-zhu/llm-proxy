/**
 * 火山方舟代理
 * 修正 Codex → 火山方舟 Responses API 的兼容性问题
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
  routes: [
    {
      prefix: "/",
      targetBaseUrl: process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
      apiKey,
      transform: compose(
        stripTopLevel(["client_metadata", "service_tier", "store", "metadata"]),
        filterTools(["function", "code_interpreter", "retrieval"]),
        fillInputItemStatus(),
      ),
    },
  ],
});
