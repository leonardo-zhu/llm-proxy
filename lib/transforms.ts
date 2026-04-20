export type Body = Record<string, unknown>;
export type Transform = (body: Body) => Body;

/** 剥掉顶层黑名单字段 */
export function stripTopLevel(blocklist: string[]): Transform {
  const set = new Set(blocklist);
  return (body) => {
    const result = { ...body };
    for (const key of set) {
      if (key in result) {
        console.log(`[proxy] stripped top-level field: ${key}`);
        delete result[key];
      }
    }
    return result;
  };
}

/** 过滤掉不支持的 tool type，全部被过滤时同时移除 tool_choice */
export function filterTools(allowedTypes: string[]): Transform {
  const allowed = new Set(allowedTypes);
  return (body) => {
    const tools = body.tools;
    if (!Array.isArray(tools) || tools.length === 0) return body;

    const filtered = tools.filter(
      (t): t is Record<string, string> =>
        typeof t === "object" && t !== null && allowed.has((t as Record<string, string>).type)
    );
    const removed = tools.length - filtered.length;
    if (removed > 0) console.log(`[proxy] stripped ${removed} unsupported tool(s)`);

    const result = { ...body };
    if (filtered.length > 0) {
      result.tools = filtered;
    } else {
      delete result.tools;
      delete result.tool_choice;
    }
    return result;
  };
}

/**
 * 补上 Responses API input item 缺少的 status 字段
 * Codex 已知 bug：多轮对话历史 item 缺少该字段，严格遵守 spec 的服务端会报 MissingParameter
 */
export function fillInputItemStatus(defaultStatus = "completed"): Transform {
  return (body) => {
    const input = body.input;
    if (!Array.isArray(input)) return body;
    return {
      ...body,
      input: input.map((item) => {
        if (typeof item !== "object" || item === null || "status" in (item as object))
          return item;
        return { ...(item as Record<string, unknown>), status: defaultStatus };
      }),
    };
  };
}

/** 把多个变换函数串联成一个 */
export function compose(...transforms: Transform[]): Transform {
  return (body) => transforms.reduce((b, fn) => fn(b), body);
}
