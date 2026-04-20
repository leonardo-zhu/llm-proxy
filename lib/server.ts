import type { Transform } from "./transforms.ts";

export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ 请先设置环境变量 ${key}`);
    process.exit(1);
  }
  return val;
}

export interface ProxyRoute {
  /** 匹配路径前缀，如 "/ark" */
  prefix: string;
  targetBaseUrl: string;
  apiKey: string;
  /** 固定转发到指定路径，不设则剥掉前缀后原样转发 */
  targetPath?: string;
  transform?: Transform;
  /** 非流式 response body 转换（Chat → Responses） */
  responseTransform?: Transform;
  /** 流式 SSE stream 转换器工厂，返回 TransformStream */
  streamTransformer?: () => TransformStream<Uint8Array, Uint8Array>;
}

export interface ServerConfig {
  port: number;
  routes: ProxyRoute[];
}

export function startProxy(config: ServerConfig) {
  const { port, routes } = config;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", timestamp: new Date().toISOString() });
      }

      const route = routes
        .filter((r) => url.pathname.startsWith(r.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length)[0];

      if (!route) {
        return Response.json({ error: "no route matched" }, { status: 404 });
      }

      if (req.method === "GET") {
        return Response.json({ object: "list", data: [] });
      }

      let body: Record<string, unknown> = {};
      try {
        body = await req.json();
      } catch {}

      if (route.transform) body = route.transform(body);

      const subPath = route.targetPath ?? (url.pathname.slice(route.prefix.length) || "/");
      const target = route.targetBaseUrl.replace(/\/$/, "") + subPath + url.search;
      console.log(`[proxy] → ${req.method} ${target} keys=${Object.keys(body).join(",")}`);

      try {
        const resp = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        const contentType = resp.headers.get("Content-Type") ?? "";

        // 流式响应：SSE stream 转换
        if (contentType.includes("text/event-stream") && route.streamTransformer && resp.body) {
          console.log(`[proxy] ← SSE stream, applying stream transformer`);
          return new Response(resp.body.pipeThrough(route.streamTransformer()), {
            status: resp.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        // 非流式响应：JSON body 转换
        const respBody = await resp.json();
        const transformed = route.responseTransform
          ? route.responseTransform(respBody as Record<string, unknown>)
          : respBody;

        return Response.json(transformed, {
          status: resp.status,
          headers: {
            "Content-Type": "application/json",
          },
        });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    },
  });

  console.log(`✅ 代理启动在 http://127.0.0.1:${server.port}`);
  for (const r of routes) {
    console.log(`   ${r.prefix}  →  ${r.targetBaseUrl}${r.targetPath ?? ""}`);
  }
}
