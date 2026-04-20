/**
 * 轻量代理：修正 Codex → 火山方舟 Responses API 的兼容性问题
 * 1. 剥掉不支持的 tool type
 * 2. 剥掉顶层未知字段
 * 3. 补上 input item 缺少的 status 字段（Codex 已知 bug）
 *
 * 运行：bun ark_proxy.ts
 * 环境变量：ARK_API_KEY, ARK_BASE_URL（可选）, PORT（可选）
 */

const LISTEN_PORT  = parseInt(process.env.PORT ?? "4000");
const ARK_BASE_URL = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";
const ARK_API_KEY  = process.env.ARK_API_KEY ?? "";

if (!ARK_API_KEY) {
  console.error("❌ 请先设置环境变量 ARK_API_KEY");
  process.exit(1);
}

// 火山方舟支持的 tool type 白名单
// web_search 故意不放行——Codex 格式里带有火山不认识的 external_web_access 字段
const ALLOWED_TOOL_TYPES = new Set([
  "function",
  "code_interpreter",
  "retrieval",
]);

// Codex 发出但火山不认识的顶层字段黑名单
const TOP_LEVEL_BLOCKLIST = new Set([
  "client_metadata",
  "service_tier",
  "store",
  "metadata",
]);

type InputItem = Record<string, unknown>;

function fixBody(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body };

  // 1. 剥顶层黑名单字段
  for (const key of TOP_LEVEL_BLOCKLIST) {
    if (key in result) {
      console.log(`[proxy] stripped top-level field: ${key}`);
      delete result[key];
    }
  }

  // 2. 剥不支持的 tool type
  const tools = result.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const filtered = tools.filter(
      (t: unknown) =>
        typeof t === "object" &&
        t !== null &&
        ALLOWED_TOOL_TYPES.has((t as Record<string, string>).type)
    );
    const removed = tools.length - filtered.length;
    if (removed > 0) console.log(`[proxy] stripped ${removed} unsupported tool(s)`);

    if (filtered.length > 0) {
      result.tools = filtered;
    } else {
      delete result.tools;
      delete result.tool_choice;
    }
  }

  // 3. 补上 input item 缺少的 status 字段
  // Codex 已知 bug：多轮对话时历史 item 缺少 Required 字段，官方 OpenAI 会静默忽略，
  // 但严格遵守 spec 的服务端（如火山）会报 MissingParameter。
  const input = result.input;
  if (Array.isArray(input)) {
    result.input = input.map((item: unknown) => {
      if (typeof item !== "object" || item === null) return item;
      const it = item as InputItem;
      if (!("status" in it)) {
        return { ...it, status: "completed" };
      }
      return it;
    });
  }

  return result;
}

const server = Bun.serve({
  port: LISTEN_PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);

    // 健康检查
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    if (req.method === "GET") {
      return Response.json({ object: "list", data: [] });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {}

    body = fixBody(body);

    const target = ARK_BASE_URL.replace(/\/$/, "") + url.pathname + url.search;
    console.log(`[proxy] → ${req.method} ${target}`);

    try {
      const resp = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ARK_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      const respBody = await resp.arrayBuffer();
      return new Response(respBody, {
        status: resp.status,
        headers: { "Content-Type": resp.headers.get("Content-Type") ?? "application/json" },
      });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  },
});

console.log(`✅ 代理启动在 http://127.0.0.1:${server.port}`);
console.log(`   转发目标：${ARK_BASE_URL}`);
