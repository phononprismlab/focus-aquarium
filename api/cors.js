// 跨域来源白名单。来源只应该由环境变量决定，写死在代码里意味着每次换域名都要改代码重新发版。
// 支持三种写法：完整来源 https://a.com、通配子域 *.tcloudbaseapp.com、null（本地 file:// 打开的页面）。
// 特殊的 "*" 表示放行所有来源，必须显式配置。

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
];

// 未配置 CORS_ORIGINS 时的兜底名单，保证历史部署不会因为漏配环境变量直接跨域失败。
export const FALLBACK_ORIGINS = [
  ...DEFAULT_DEV_ORIGINS,
  "https://test-d0gpv0jya4925be19-1491495221.tcloudbaseapp.com",
  "https://focus-aquarium-test-d0gpv0jya4925be19.webapps.tcloudbase.com"
];

export function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
}

// "*" 之外的通配只支持后缀形式（*.example.com），避免误配成前缀通配把恶意域名放进来。
function matchesRule(origin, rule) {
  if (rule === "*") return true;
  if (rule === "null") return origin === "null";
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1); // 保留 ".example.com"
    return origin.endsWith(suffix) && origin.length > suffix.length;
  }
  return origin === rule;
}

export function createOriginChecker(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const allowAll = list.includes("*");
  return function isOriginAllowed(origin) {
    // 没有 Origin 头的请求不是浏览器跨域（curl、服务端调用、同域），不受白名单约束。
    if (!origin) return true;
    if (allowAll) return true;
    return list.some(rule => matchesRule(origin, rule));
  };
}

export function resolveAllowList(env = process.env) {
  const configured = parseOrigins(env.CORS_ORIGINS);
  if (configured.length) return { origins: configured, source: "env" };
  return { origins: FALLBACK_ORIGINS, source: "default" };
}
