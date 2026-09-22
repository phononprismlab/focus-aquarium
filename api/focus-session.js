// 专注会话存储：记录开始时间，结算时由服务端推算实际时长。
// 独立成模块是为了可测试 —— 注入 now() 就能在测试里模拟时间流逝。
import { randomUUID } from "node:crypto";
import { computeFocusReward, resolveMaxMinutes } from "./reward.js";

export const FOCUS_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
// 计时器到点和请求到达之间有网络与调度延迟，留一点余量，
// 否则 25 分钟整完成时可能被算成 24 分钟，少发一档奖励。
export const COMPLETION_TOLERANCE_MS = 5000;

export function createFocusSessionStore({ now = () => Date.now(), ttlMs = FOCUS_SESSION_TTL_MS } = {}) {
  const sessions = new Map();

  function prune() {
    const current = now();
    for (const [id, session] of sessions) {
      if (current - session.startedAt > ttlMs) sessions.delete(id);
    }
  }

  return {
    start({ plannedMinutes, isMember }) {
      prune();
      const startedAt = now();
      const sessionId = randomUUID();
      const session = {
        sessionId,
        plannedMinutes: Number(plannedMinutes),
        isMember: isMember === true,
        startedAt
      };
      sessions.set(sessionId, session);
      return { sessionId, startedAt, plannedMinutes: session.plannedMinutes };
    },

    // 结算并消费会话。返回 null 表示会话不存在、已过期或已被结算过（防重放）。
    settle(sessionId, focusConfig) {
      // 先剪枝再查，否则一个放置超过 TTL 的会话仍能被结算，
      // 与"过期即失效"的约定不符。配置上限（2 小时）远小于 TTL，正常流程不受影响。
      prune();
      const session = sessions.get(sessionId);
      if (!session) return null;
      sessions.delete(sessionId);

      const settledAt = now();
      const elapsedMs = Math.max(0, settledAt - session.startedAt);
      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      const maxMinutes = resolveMaxMinutes(focusConfig);

      // 是否算作自然完成由服务端根据实际耗时判断，不采信客户端声明。
      const naturalCompletion = elapsedMs >= session.plannedMinutes * 60000 - COMPLETION_TOLERANCE_MS;
      const countedMinutes = Math.min(
        naturalCompletion ? session.plannedMinutes : elapsedMinutes,
        maxMinutes
      );

      return {
        reward: computeFocusReward(countedMinutes, session.isMember, focusConfig.rewardTiers),
        elapsedMinutes,
        countedMinutes,
        capped: elapsedMinutes > maxMinutes,
        naturalCompletion,
        isMember: session.isMember,
        settledAt
      };
    },

    size() { return sessions.size; },
    clear() { sessions.clear(); }
  };
}
