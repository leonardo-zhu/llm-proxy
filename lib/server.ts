import type { Transform } from "./transforms.ts";

export interface ProxyRoute {
  /** 匹配路径前缀，如 "/ark" */
  prefix: string;
  targetBaseUrl: string;
  apiKey: string;
  /** 转发前对请求体做的变换 */
  transform?: Transform;
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

      // 找最长匹配的路由前缀
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

      // 剥掉路由前缀，拼接目标 URL
      const subPath = url.pathname.slice(route.prefix.length) || "/";
      const target = route.targetBaseUrl.replace(/\/$/, "") + subPath + url.search;
      console.log(`[proxy] → ${req.method} ${target}`);

      try {
        const resp = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        const respBody = await resp.arrayBuffer();
        return new Response(respBody, {
          status: resp.status,
          headers: {
            "Content-Type": resp.headers.get("Content-Type") ?? "application/json",
          },
        });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    },
  });

  console.log(`✅ 代理启动在 http://127.0.0.1:${server.port}`);
  for (const r of routes) {
    console.log(`   ${r.prefix}  →  ${r.targetBaseUrl}`);
  }
}
