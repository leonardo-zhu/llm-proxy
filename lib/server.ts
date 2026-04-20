import type { Transform } from "./transforms.ts";

export interface ProxyConfig {
  port: number;
  targetBaseUrl: string;
  apiKey: string;
  /** 转发前对请求体做的变换，默认不变换 */
  transform?: Transform;
}

export function startProxy(config: ProxyConfig) {
  const { port, targetBaseUrl, apiKey, transform } = config;
  const base = targetBaseUrl.replace(/\/$/, "");

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req) {
      const url = new URL(req.url);

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

      if (transform) body = transform(body);

      const target = base + url.pathname + url.search;
      console.log(`[proxy] → ${req.method} ${target}`);

      try {
        const resp = await fetch(target, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
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
  console.log(`   转发目标：${targetBaseUrl}`);
}
