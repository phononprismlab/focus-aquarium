// 专注奖励的权威计算逻辑。
// 客户端也有一份等价实现用于离线兜底，但线上结算一律以服务端为准：
// 服务端根据自己记录的开始时间推算实际专注时长，客户端无法凭空声明时长。

// 与客户端保持一致的公式：按 rewardTiers 的 endMinute 分段累加。
// 每一段的区间是 (previousEnd, endMinute]，会员与普通用户取不同的每分钟泡泡数。
export function computeFocusReward(minutes, isMember, rewardTiers) {
  const wholeMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
  const tiers = (Array.isArray(rewardTiers) ? [...rewardTiers] : [])
    .map(tier => ({
      endMinute: Number(tier?.endMinute),
      normalBubblePerMinute: Number(tier?.normalBubblePerMinute) || 0,
      memberBubblePerMinute: Number(tier?.memberBubblePerMinute) || 0
    }))
    .filter(tier => Number.isFinite(tier.endMinute) && tier.endMinute > 0)
    .sort((a, b) => a.endMinute - b.endMinute);

  let reward = 0;
  let previousEnd = 0;
  for (const tier of tiers) {
    if (tier.endMinute <= previousEnd) continue; // 忽略重复或倒序的梯度
    const tierMinutes = Math.max(0, Math.min(wholeMinutes, tier.endMinute) - previousEnd);
    const perMinute = isMember ? tier.memberBubblePerMinute : tier.normalBubblePerMinute;
    reward += tierMinutes * perMinute;
    previousEnd = tier.endMinute;
    if (wholeMinutes <= tier.endMinute) break;
  }
  return Math.max(0, Math.floor(reward));
}

// 专注时长上限，避免客户端伪造一个超大时长刷奖励。
// 取配置里的 maxFocusDuration，并再套一层硬上限作为保险。
export const HARD_MAX_MINUTES = 600;

export function resolveMaxMinutes(focusConfig) {
  const configured = Number(focusConfig?.maxFocusDuration);
  if (!Number.isFinite(configured) || configured <= 0) return HARD_MAX_MINUTES;
  return Math.min(configured, HARD_MAX_MINUTES);
}

export function validateStartRequest(body, focusConfig) {
  if (!body || typeof body !== "object") return "请求体必须是对象";
  const plannedMinutes = Number(body.plannedMinutes);
  const minMinutes = Number(focusConfig?.minFocusDuration);
  const maxMinutes = resolveMaxMinutes(focusConfig);
  if (!Number.isFinite(plannedMinutes) || plannedMinutes <= 0) return "plannedMinutes 必须是正数";
  if (Number.isFinite(minMinutes) && plannedMinutes < minMinutes) return `plannedMinutes 不能小于 ${minMinutes}`;
  if (plannedMinutes > maxMinutes) return `plannedMinutes 不能大于 ${maxMinutes}`;
  return null;
}
