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
