import { startProxy } from "./lib/server.ts";
import { routes as arkRoutes } from "./proxies/ark.ts";

startProxy({
  port: 4000,
  routes: [
    ...arkRoutes,
    // 以后加新 proxy：import 进来 spread 进去
  ],
});
