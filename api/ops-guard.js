// 停机闸门的判定逻辑（纯函数，可单测）。
//
// 为什么单独一个文件：server.js 一被 import 就会起服务、连数据库，
// 纯逻辑必须能脱离它测，否则「白名单豁免」这种分支只能靠手工点后台验证。
//
// 停机是**服务端闸门**：玩家往 URL 上加参数绕不过服务端，
// 能豁免的只有后台填进 maintenanceAllowUids 的 uid。

// ops：已发布的运营配置（读不到时传 null/undefined）。
// uid：请求者 uid，未登录为空串。
// 返回 true = 应当拦截（维护中且不在白名单）。
export function isMaintenanceBlocked(ops, uid) {
  // 读不到配置 → 失败开放。一次配置接口抖动不该把全站变成维护页。
  if (!ops || typeof ops !== "object") return false;
  if (ops.maintenance !== true) return false;
  const allow = Array.isArray(ops.maintenanceAllowUids) ? ops.maintenanceAllowUids : [];
  if (uid && allow.includes(uid)) return false;
  return true;
}
