import { compose, stripTopLevel, filterTools, fillInputItemStatus } from "../lib/transforms.ts";
import { requireEnv } from "../lib/server.ts";
import type { ProxyRoute } from "../lib/server.ts";

export const routes: ProxyRoute[] = [
  {
    prefix: "/ark",
    targetBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: requireEnv("ARK_API_KEY"),
    transform: compose(
      stripTopLevel(["client_metadata", "service_tier", "store", "metadata"]),
      filterTools(["function", "code_interpreter", "retrieval"]),
      fillInputItemStatus(),
    ),
  },
];
