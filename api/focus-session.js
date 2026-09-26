// 专注会话存储：记录开始时间，结算时由服务端推算实际时长。
// 独立成模块是为了可测试 —— 注入 now() 就能在测试里模拟时间流逝。
//
// ===== 为什么要有「持久层」这一档 =====
// 会话原本只存在进程内存的 Map 里。云托管是自动扩缩容的，这带来两个真问题：
//   ① 同一个会话的 start 与 complete 可能落在**不同实例**上 → complete 查不到会话，404。
//   ② 进程重启（发版 / 扩缩容 / 冷启动）会清空 Map → 正在专注的人结算失败，奖励发不出去。
// 所以结算改为优先去 focus_records 表查那一行 —— start 时本来就已经把那行写进去了，
// 不需要新建表、也不需要数据迁移；内存 Map 退化为「数据库不可用时的兜底」。
//
// ⚠️ 结算换算（时长 / 奖励 / 是否自然完成）仍然只由服务端算，客户端声明一概不采信。
//    持久层只负责回答三件事：会话何时开始、属于谁、有没有被结算过。
import { randomUUID } from "node:crypto";
import { computeFocusReward, resolveMaxMinutes } from "./reward.js";

export const FOCUS_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
// 计时器到点和请求到达之间有网络与调度延迟，留一点余量，
// 否则 25 分钟整完成时可能被算成 24 分钟，少发一档奖励。
export const COMPLETION_TOLERANCE_MS = 5000;

// 依据「开始时间 + 计划时长 + 会员标记」算出结算结果。
// 抽成纯函数是因为有两个来源（数据库 / 内存），两条路径必须得出完全一样的结果 ——
// 同一个会话在「库挂了」前后算出不同奖励，那种不一致比算错更难查。
export function settleSession({ startedAt, plannedMinutes, isMember = false, settledAt, focusConfig }) {
  const elapsedMs = Math.max(0, settledAt - startedAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60000);
  const maxMinutes = resolveMaxMinutes(focusConfig);

  // 是否算作自然完成由服务端根据实际耗时判断，不采信客户端声明。
  const naturalCompletion = elapsedMs >= plannedMinutes * 60000 - COMPLETION_TOLERANCE_MS;
  const countedMinutes = Math.min(
    naturalCompletion ? plannedMinutes : elapsedMinutes,
    maxMinutes
  );

  return {
    reward: computeFocusReward(countedMinutes, isMember, focusConfig.rewardTiers),
    elapsedMinutes,
    countedMinutes,
    capped: elapsedMinutes > maxMinutes,
    naturalCompletion,
    isMember,
    settledAt
  };
}

// 会话是否已超出可结算窗口。
const isExpired = (startedAt, current, ttlMs) => current - startedAt > ttlMs;

export function createFocusSessionStore({
  now = () => Date.now(),
  ttlMs = FOCUS_SESSION_TTL_MS,
  // 持久层（可选）。传进来就能跨实例、跨重启结算；不传则退回纯内存（单测 / 无库环境）。
  // 需要三个方法：findSession(id) / consumeSession(id) / settleSession(id, patch)。
  persistence = null,
  onPersistError = null
} = {}) {
  const sessions = new Map();
  const reportError = stage => error => {
    // 持久层出错不能把专注本身搞挂 —— 只上报，然后走内存兜底。
    if (typeof onPersistError === "function") onPersistError(stage, error);
  };

  function prune() {
    const current = now();
    for (const [id, session] of sessions) {
      if (isExpired(session.startedAt, current, ttlMs)) sessions.delete(id);
    }
  }

  return {
    // uid 一并记下：会话必须绑定发起人，否则谁拿到 sessionId 都能替别人结算。
    // '' = 未登录（专注本身不要求登录，这种会话不校验归属）。
    start({ plannedMinutes, isMember, uid = null }) {
      prune();
      const session = {
        sessionId: randomUUID(),
        plannedMinutes: Number(plannedMinutes),
        isMember: isMember === true,
        startedAt: now(),
        uid: uid === null || uid === undefined ? "" : String(uid)
      };
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, startedAt: session.startedAt, plannedMinutes: session.plannedMinutes };
    },

    // 结算并消费会话。返回 null = 不存在 / 已过期 / 已结算过（防重放）。
    // 返回 { error, code } = 会话存在但调结者不是它的主人。
    // 改成 async：可能要查一次数据库。
    //
    // 顺序很关键 —— **先查库（权威），查不到再回退内存**：
    //   · 库里与内存都有 → 用库里的（它那份 startedAt 才是跨实例都认的）
    //   · 内存有库没有 → 未登录会话 / 落库失败，用内存的
    //   · 内存没有库里有 → 多实例或重启后的正常情况，用库里的 ← 这就是本次要修的场景
    //   · 查库本身抛错（不是"没查到"）→ 完全退回内存，不让数据库抖动影响发奖
    async settle(sessionId, focusConfig, { uid = null } = {}) {
      prune();
      const memorySession = sessions.get(sessionId);

      let source = null;
      if (persistence) {
        try {
          const row = await persistence.findSession(sessionId);
          if (row) {
            source = {
              sessionId: String(row.session_id != null ? row.session_id : (row.sessionId || sessionId)),
              plannedMinutes: Number(row.planned_minutes != null ? row.planned_minutes : row.plannedMinutes) || 0,
              isMember: row.is_member === true || row.isMember === true,
              startedAt: Number(row.started_at != null ? row.started_at : row.startedAt) || 0,
              uid: String(row.user_id != null ? row.user_id : (row.uid || ""))
            };
          }
        } catch (error) {
          reportError("find")(error);
        }
      }
      if (!source && memorySession) source = memorySession;
      if (!source || !source.startedAt) return null;

      const current = now();
      if (isExpired(source.startedAt, current, ttlMs)) {
        sessions.delete(sessionId);
        return null;
      }

      // 🔴 归属校验：会话记了发起人，结算请求者也必须是他。
      //    未登录会话（uid 为 ''）不校验 —— 那是不绑定任何账号的本地专注。
      //    isMember 取**会话开始时服务端裁定**的那个值，不用调用方传的（免得被抬成会员档）。
      if (source.uid && uid && source.uid !== String(uid)) {
        return { error: "这个专注会话不属于当前账号", code: "SESSION_OWNER_MISMATCH" };
      }
      const memberForReward = source.isMember === true;

      // CAS：把 settled_at 从 0 抢成非 0。抢不到 = 别的实例 / 别的请求已经结算过了。
      // 这一步是防重放的关键 —— 没有它，两个并发 complete 会各发一次奖励。
      if (persistence) {
        try {
          const claimed = await persistence.consumeSession(sessionId, source.startedAt);
          if (claimed === false) {
            sessions.delete(sessionId); // 已被别处结算 → 内存里这份也失效
            return null;
          }
        } catch (error) {
          reportError("consume")(error);
        }
      }
      sessions.delete(sessionId);

      const settledAt = now();
      const result = settleSession({
        startedAt: source.startedAt,
        plannedMinutes: source.plannedMinutes,
        isMember: memberForReward,
        settledAt,
        focusConfig
      });

      if (persistence) {
        // 把真正的结算结果补写回去（上一步 CAS 只抢了 settled_at）。
        // 写失败不影响发奖：奖励由本次响应下发，统计少一条而已。
        try {
          await persistence.settleSession(sessionId, {
            countedMinutes: result.countedMinutes,
            reward: result.reward,
            natural: result.naturalCompletion ? 1 : 0,
            settledAt: result.settledAt
          });
        } catch (error) {
          reportError("settle")(error);
        }
      }
      return result;
    },

    size() { return sessions.size; },
    clear() { sessions.clear(); }
  };
}
