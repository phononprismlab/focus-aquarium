// 随机事件的配置校验规则。抽成独立模块，服务端与测试共用同一份判断。
//
// 事件是**配置驱动**的：后台只填参数，不写代码（用户 2026-09-23 决定）。
// 所以 `handler` 必须是这里列出的内置处理器之一 —— 白名单在服务端把关，
// 避免后台配出一个玩家端根本不认识的事件（那种错误只会在线上暴露）。
//
// ⚠️ 这份名单必须与 index.html 里的 EVENT_HANDLERS 保持一致。
//    两边不一致时 `api/test/events.test.js` 会失败。

export const EVENT_HANDLERS = ["give-bubbles", "treasure", "fish-escape"];
export const EVENT_TYPES = ["online", "offline"];
// 这些 handler 靠 params.min / params.max 决定给多少泡泡 —— 配错了事件就永远不触发，
// 所以服务端直接强制校验，别让它在线上静默失效。
export const BUBBLE_RANGE_HANDLERS = ["give-bubbles", "treasure"];
// id 会被当作配置主键、localStorage 后缀使用，限制字符集。
export const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

// ===== 事件奖励的服务端闸门 =====
//
// 事件的**触发判定仍在前端**（5s 心跳、命中概率也配在前端）。服务端不复现触发条件 ——
// 它只强制两件配置里本来就写着的事：**冷却**与**每日上限**。
//
// 于是伪造一次事件最多拿到「配置允许的那一份」，而不是无限泡泡。
// 账本直接用 grants 表：每发一次就留一行 `reason = "event:<id>"`，
// 行数就是「今天发过几次」，最大的 created_at 就是「上次什么时候发的」。
//
// ⚠️ reason 必须**精确匹配**整个 `event:<id>`，不能用前缀模糊 —— 否则
//    `event:e1` 与 `event:e10` 会互相污染配额。
export const EVENT_REWARD_REASON_PREFIX = "event:";
export const eventRewardReason = id => `${EVENT_REWARD_REASON_PREFIX}${String(id)}`;

// 裁定「这次事件奖励该不该发、发多少」。纯函数，冷却与上限所需的状态由调用方查好传进来。
//
//   config    已发布的该事件配置
//   observed  { count, lastAt } —— 该用户今天已发次数 / 上次发放时间（来自 queryGrants）
//   requested 客户端报的数量。**只作为上限内的意图**：服务端钳到 [min, max]，
//             传了非法值就按 min 发（保守），绝不采信区间外的数。
//   now       当前时间戳
export function planEventReward({ config, observed, requested, now }) {
  if (!config || !config.id) return { ok: false, code: "EVENT_NOT_FOUND", error: "事件不存在或已下架" };
  if (config.enabled === false) return { ok: false, code: "EVENT_DISABLED", error: "这个事件已停用" };
  // 只有靠 min/max 决定给多少泡泡的 handler 才发奖。fish-escape 是消耗端，不发泡泡。
  if (!BUBBLE_RANGE_HANDLERS.includes(config.handler)) {
    return { ok: false, code: "EVENT_NO_BUBBLES", error: "这个事件不发泡泡" };
  }

  const min = Number(config.params && config.params.min);
  const max = Number(config.params && config.params.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return { ok: false, code: "EVENT_BAD_CONFIG", error: "事件奖励区间配置不合法" };
  }

  const maxPerDay = Math.max(1, Math.floor(Number(config.maxPerDay) || 1));
  const usedToday = Math.max(0, Math.floor(Number(observed && observed.count) || 0));
  if (usedToday >= maxPerDay) {
    return { ok: false, code: "DAILY_LIMIT", error: "这个事件今天已经发生够了", maxPerDay, usedToday };
  }

  const cooldownMs = Math.max(0, Number(config.cooldownMinutes) || 0) * 60000;
  const lastAt = Number(observed && observed.lastAt) || 0;
  const readyAt = lastAt + cooldownMs;
  if (cooldownMs > 0 && lastAt > 0 && readyAt > now) {
    return { ok: false, code: "COOLDOWN", error: "这个事件还在冷却中", readyAt, remainingMs: readyAt - now };
  }

  const rolled = Math.floor(Number(requested));
  const bubbles = Math.min(max, Math.max(min, Number.isFinite(rolled) ? rolled : min));
  return { ok: true, bubbles, reason: eventRewardReason(config.id) };
}

export function validateEventConfig(data) {
  if (!data.id || typeof data.id !== "string") return "事件必须包含 id";
  if (!EVENT_ID_PATTERN.test(data.id)) return `事件 id 只能是字母、数字、下划线或连字符（1-48 位）：${data.id}`;
  if (!data.name || typeof data.name !== "string" || !data.name.trim()) return "事件必须填写名称";
  if (!EVENT_HANDLERS.includes(data.handler)) {
    return `事件 handler 无效：${data.handler ?? "(空)"}（可选：${EVENT_HANDLERS.join(" / ")}）`;
  }
  const eventType = data.eventType || "online";
  if (!EVENT_TYPES.includes(eventType)) {
    return `事件 eventType 无效：${eventType}（可选：${EVENT_TYPES.join(" / ")}）`;
  }
  if (data.params != null && (typeof data.params !== "object" || Array.isArray(data.params))) {
    return "事件的 params 必须是对象";
  }
  if (BUBBLE_RANGE_HANDLERS.includes(data.handler)) {
    const min = Number(data.params && data.params.min);
    const max = Number(data.params && data.params.max);
    if (!Number.isFinite(min) || min < 1) return `${data.handler} 的 params.min 至少为 1（否则事件永远不会触发）`;
    if (!Number.isFinite(max) || max < min) return `${data.handler} 的 params.max 不能小于 params.min`;
  }
  if ((data.eventType || "online") === "offline" && data.params && data.params.maxOfflineHours != null) {
    const cap = Number(data.params.maxOfflineHours);
    if (!Number.isFinite(cap) || cap < 1) return "离线事件的 params.maxOfflineHours 至少为 1 小时";
  }
  if (data.conditions != null && (typeof data.conditions !== "object" || Array.isArray(data.conditions))) {
    return "事件的 conditions 必须是对象";
  }

  const probability = Number(data.probability);
  if (!Number.isFinite(probability) || probability <= 0 || probability > 1) {
    return "probability 必须在 0（不含）-1 之间";
  }
  // 检测间隔只有在线事件用得上：离线事件是按「再次进入」结算的，配了也没人读。
  if (eventType === "online") {
    const interval = Number(data.checkIntervalSeconds);
    if (!Number.isFinite(interval) || interval < 5) return "在线事件的 checkIntervalSeconds 不能小于 5 秒";
  } else if (data.checkIntervalSeconds != null && Number(data.checkIntervalSeconds) < 5) {
    return "checkIntervalSeconds 不能小于 5 秒";
  }
  const cooldown = Number(data.cooldownMinutes);
  if (!Number.isFinite(cooldown) || cooldown < 0) return "cooldownMinutes 不能为负数";
  const maxPerDay = Number(data.maxPerDay);
  if (!Number.isFinite(maxPerDay) || maxPerDay < 1) return "maxPerDay 至少为 1";

  if (typeof data.message !== "string" || !data.message.trim()) return "事件必须填写叙事文案 message";

  // treasure 的文案要用到命中的资源名，没有 relatedTag 就永远匹配不到资源。
  if (data.handler === "treasure" && !String(data.relatedTag || "").trim()) {
    return "treasure 事件必须填写 relatedTag（用来关联带该标签的装扮）";
  }

  return null;
}
