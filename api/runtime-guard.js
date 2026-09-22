// 启动期的环境校验。抽成独立模块是为了能直接单测，不用真的去起服务进程。
//
// 背景：ADMIN_API_KEY 未配置时 /api/admin/* 会完全开放。开发时图方便可以接受，
// 生产环境一旦漏配就是"谁都能改游戏配置"，所以生产环境必须直接拒绝启动。

export const MIN_RECOMMENDED_ADMIN_KEY_LENGTH = 16;

// 密钥统一 trim：环境变量里不小心带上的空格会让比对永远失败，
// 或者出现 "   " 这种看起来配了、实际等于没配的值。
export function resolveAdminApiKey(env = process.env) {
  return String(env.ADMIN_API_KEY || "").trim();
}

// 返回错误信息表示不该启动；返回 null 表示校验通过。
export function checkProductionConfig({ nodeEnv, adminApiKey } = {}) {
  if (nodeEnv !== "production") return null;
  if (!adminApiKey) {
    return "生产环境必须配置 ADMIN_API_KEY：未配置时 /api/admin/* 无需任何凭据即可修改游戏配置。已拒绝启动。";
  }
  return null;
}

// 弱密钥只警告不拦截：太短容易被猜，但强行拦截会把一些已有部署卡死。
export function warnWeakAdminKey(adminApiKey, log = console.warn) {
  if (!adminApiKey || adminApiKey.length >= MIN_RECOMMENDED_ADMIN_KEY_LENGTH) return null;
  const message = `ADMIN_API_KEY 仅 ${adminApiKey.length} 位，建议至少 ${MIN_RECOMMENDED_ADMIN_KEY_LENGTH} 位随机字符。`;
  log(message);
  return message;
}
