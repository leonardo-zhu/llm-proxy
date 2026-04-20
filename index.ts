import { startProxy } from "./lib/server.ts";
import { route as ark } from "./proxies/ark.ts";
import { route as minimax } from "./proxies/minimax.ts";

startProxy({
  port: 4000,
  routes: [ark, minimax],
});
