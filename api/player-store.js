// 玩家数据层：账号、存档、专注记录。
//
// 与 repository.js 的分工：
//   repository   管「游戏配置」—— 后台编辑、公开下发给所有人，全服一份。
//   playerStore  管「玩家自己的数据」—— 每人一份，互不可见。
// 两者共用同一个 RDB 客户端（见 repository.js 的 getRdb），但表完全不同。
//
// ===== 这里最关键的一件事：存档合并的安全边界 =====
//
// 定稿要求「经济数据只由服务端改」，但存档本身是**前端推上来的整包**。
// 这两条直接冲突：整包接受 = 客户端能改泡泡；整包拒绝 = 玩家的鱼缸布置存不下来。
// 所以合并必须按字段分权：
//
//   🔴 服务端权威（客户端提交的值一律丢弃，保留服务端值）
//      PlayerData.inventory    —— 买了什么、各多少件。这是「不能白嫖商品」的最后一道闸：
//                                 商品只能经 POST /api/game/shop/buy 获得，价格以服务端配置为准。
//      PlayerData.isMember     —— 会员标记（V1.0 不卖会员，但也不能让客户端自己开）
//
//   🟢 客户端权威（接受客户端值，只做范围钳制）
//      PlayerData.bubbles      —— 见下面「泡泡为什么暂时是客户端权威」
//      AquariumData.*           —— 鱼缸布局：选中哪条鱼、哪个背景/沙/装饰/音效
//      Settings.*               —— 音量等偏好
//
// ===== 泡泡为什么暂时是客户端权威（已知欠账，公开发布前必须收紧）=====
//
// 定稿写的是「经济数据只由服务端改」。要真正做到，泡泡的每一次变动都得走服务端：
// 专注奖励（已做到，focus/complete 服务端结算）、以及 4 个随机事件给的泡泡。
// 但**事件检测完全在前端**（5s 心跳、命中概率也配在前端），服务端拿不到可信的触发证据，
// 要校验就得把整套事件系统搬到服务端 —— 那是好几天的工作量，会把 11/4 上线推后。
//
// 灰度期的实际风险：改存档需要玩家主动开 DevTools 改 localStorage，不是点两下就能做到的；
// 灰度对象是 20–30 个熟人，没有真实支付、没有会员、没有排行榜与社交，
// 改出来的泡泡只能影响他自己那个鱼缸。这个风险可以接受。
//
// ⚠️ 收紧的前提条件（任一满足就该动手）：
//   · 开始有真实陌生用户 / 真实支付
//   · 上线任何形式的排行榜、社交或分享对比
//   收紧方式：泡泡也归服务端权威，事件命中改为上报服务端、由服务端按额度与每日上限发奖。
//
// 但 AquariumData 不能无条件信任 —— 它是**间接的经济出口**：
//   · 摆 1000 条鱼 → 不校验就能白嫖（鱼的条数必须 ≤ 库存条数）
//   · 选中没买过的背景 → 不校验就能白嫖（选中的 id 必须已在库存里）
// 所以这两个不变量必须由服务端强制，见 mergeSaveForWrite。
import { getRdb } from "./repository.js";

export const TABLE_USERS = "users";
export const TABLE_SAVES = "saves";
export const TABLE_FOCUS_RECORDS = "focus_records";

// 库存分类键。与前端 ensureInventory 里的五个分类保持一致。
export const INVENTORY_CATEGORIES = ["fish", "decorations", "backgrounds", "sands", "sounds"];
// 鱼缸里「只能选中一件」的槽位。每个槽位的值必须已在对应分类的库存里。
export const SINGLE_SLOT_FIELDS = {
  decoration: "decorations",
  background: "backgrounds",
  sand: "sands",
  ambientSound: "sounds"
};

// 单次推送允许的泡泡增长上限。
// 正常游玩两次推送之间的增量是个位数到几百（一次 25 分钟专注 + 几个事件），
// 离线一整天再回来也远到不了这个数。超出的截断。
// ⚠️ 这不是安全边界（泡泡是客户端权威），只是一道「别让 999999999 直接写进来」的兜底。
export const MAX_BUBBLE_GAIN_PER_PUSH = 2000;
export const MAX_BUBBLES = 1_000_000_000;

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// 泡泡一律取整、非负、有上限。任何一步失败都回落到 0 而不是 NaN ——
// NaN 会一路传染到前端显示成「🫧 NaN」。
export function normalizeBubbles(value, { cap = MAX_BUBBLES } = {}) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, cap);
}

export function normalizeInventory(value) {
  const source = isPlainObject(value) ? value : {};
  const result = {};
  for (const category of INVENTORY_CATEGORIES) {
    const bucket = isPlainObject(source[category]) ? source[category] : {};
    const clean = {};
    for (const [id, count] of Object.entries(bucket)) {
      if (!id) continue;
      const n = Math.floor(Number(count));
      if (Number.isFinite(n) && n > 0) clean[id] = n;
    }
    result[category] = clean;
  }
  return result;
}

export function defaultPlayer({ bubbles = 0, inventory = {} } = {}) {
  return { bubbles: normalizeBubbles(bubbles), isMember: false, inventory: normalizeInventory(inventory) };
}

// 音量等偏好：0–100 的整数，未知键丢弃（配置分类可能已经改了，旧的键不该一直堆在存档里）。
export function normalizeSettings(value) {
  const source = isPlainObject(value) ? value : {};
  const audioSource = isPlainObject(source.audio) ? source.audio : {};
  const audio = {};
  for (const [key, volume] of Object.entries(audioSource)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) continue;
    const n = Math.round(Number(volume));
    if (Number.isFinite(n)) audio[key] = Math.min(100, Math.max(0, n));
  }
  return { ...source, audio };
}

// 校验鱼缸布局。
//   · 鱼的条数：按 itemId 分组计数，超过库存的部分直接丢掉（这是白嫖鱼的主要入口）
//   · 单选槽位：值非空时必须在库存里有货，否则保留服务端上一次的合法值
// 返回 { aquarium, problems }，problems 只用于日志与测试，不下发给玩家 ——
// 玩家看到的应该是「布置没生效」，而不是一串内部校验错误。
//
// respectEmpty：空值算不算「明确的意图」。
//   false（默认，用于 PUT /api/game/save）：空值当作「客户端没提交这个字段」，
//     保留服务端原值 —— 布局同步是整包推送，漏传一个字段不该把玩家的布置清空。
//   true（用于批量结算）：空值就是「我要撤下它」，必须照办，否则玩家撤不掉背景。
export function normalizeAquarium(value, inventory, previous = {}, { respectEmpty = false } = {}) {
  const source = isPlainObject(value) ? value : {};
  const previousAquarium = isPlainObject(previous) ? previous : {};
  const problems = [];
  const owned = (inventory && inventory.fish) || {};
  const used = {};
  const fish = [];

  for (const entry of Array.isArray(source.fish) ? source.fish : []) {
    if (!isPlainObject(entry) || !entry.itemId) {
      problems.push("丢弃了一条没有 itemId 的鱼");
      continue;
    }
    const limit = Math.max(0, Math.floor(Number(owned[entry.itemId]) || 0));
    used[entry.itemId] = (used[entry.itemId] || 0) + 1;
    if (used[entry.itemId] > limit) {
      problems.push(`鱼 ${entry.itemId} 超出库存（库存 ${limit} 条），已丢弃多出的部分`);
      continue;
    }
    fish.push(entry);
  }

  const aquarium = { ...source, fish };
  for (const [field, category] of Object.entries(SINGLE_SLOT_FIELDS)) {
    const id = source[field];
    if (id === undefined) continue; // 客户端没提交这个字段 → 保持服务端原值
    if (id === "" || id === null) {
      aquarium[field] = respectEmpty ? "" : (previousAquarium[field] || "");
      continue;
    }
    const count = Math.floor(Number((inventory && inventory[category] || {})[id]) || 0);
    if (count > 0) continue;
    problems.push(`选中的 ${field}（${id}）不在库存里，已保留原值`);
    aquarium[field] = previousAquarium[field] || "";
  }
  return { aquarium, problems };
}

// 存档合并的**唯一入口**。stored 为 null 表示这个账号还没有存档（首次同步）。
export function mergeSaveForWrite(stored, incoming, { saveVersion = "" } = {}) {
  const problems = [];
  const incomingSave = isPlainObject(incoming) ? incoming : {};
  const incomingPlayer = isPlainObject(incomingSave.PlayerData) ? incomingSave.PlayerData : {};
  const hasStored = isPlainObject(stored) && isPlainObject(stored.PlayerData);

  let player;
  if (!hasStored) {
    // 首次同步：服务端还没有基线，只能以玩家的本地存档为准。
    // 这不是「信任客户端」的问题 —— 玩家的进度确实只存在于他的浏览器里，
    // 服务端没有任何依据可以核对。若强行从 0 开始，等于把历史进度抹掉。
    player = defaultPlayer({
      bubbles: normalizeBubbles(incomingPlayer.bubbles),
      inventory: incomingPlayer.inventory
    });
  } else {
    // 已有存档：库存与会员标记以服务端为准，泡泡接受客户端的（带增长上限）。
    const serverPlayer = stored.PlayerData;
    for (const key of ["isMember", "inventory"]) {
      if (key in incomingPlayer) problems.push(`忽略了客户端提交的 PlayerData.${key}`);
    }
    const serverBubbles = normalizeBubbles(serverPlayer.bubbles);
    const submitted = normalizeBubbles(incomingPlayer.bubbles);
    if (submitted > serverBubbles + MAX_BUBBLE_GAIN_PER_PUSH) {
      problems.push(`泡泡增量超过单次上限（服务端 ${serverBubbles} → 提交 ${submitted}），已截断`);
    }
    player = {
      bubbles: Math.min(submitted, serverBubbles + MAX_BUBBLE_GAIN_PER_PUSH),
      isMember: serverPlayer.isMember === true,
      inventory: normalizeInventory(serverPlayer.inventory)
    };
  }

  const previousAquarium = hasStored && isPlainObject(stored.AquariumData) ? stored.AquariumData : {};
  const { aquarium, problems: aquariumProblems } = normalizeAquarium(
    incomingSave.AquariumData,
    player.inventory,
    previousAquarium
  );

  const settings = incomingSave.Settings === undefined
    ? (hasStored && isPlainObject(stored.Settings) ? stored.Settings : normalizeSettings({}))
    : normalizeSettings(incomingSave.Settings);

  return {
    save: {
      saveVersion: saveVersion || String(incomingSave.saveVersion || (hasStored && stored.saveVersion) || ""),
      PlayerData: player,
      AquariumData: aquarium,
      Settings: settings
    },
    problems: [...problems, ...aquariumProblems],
    firstPush: !hasStored
  };
}

// ===== 购买：经济数据的唯一合法写入路径 =====
//
// 客户端「自己扣泡泡加库存」在服务端权威之后就不成立了，所以购买必须是一次服务端事务：
// 校验商品 → 校验余额 → 校验库存上限 → 扣泡泡 → 加库存。
// 这里做成纯函数，返回结果对象而不是直接写库，方便单测覆盖每个分支。
export function planPurchase({ save, item, ownedCount = 0 }) {
  if (!isPlainObject(save) || !isPlainObject(save.PlayerData)) {
    return { error: "还没有存档，请先完成一次同步", code: "NO_SAVE" };
  }
  if (!isPlainObject(item)) return { error: "商品不存在", code: "NO_ITEM" };

  const price = Math.floor(Number(item.price));
  if (!Number.isFinite(price) || price < 0) return { error: "商品价格不合法", code: "BAD_PRICE" };

  const max = Math.floor(Number(item.maxInventory));
  const owned = Math.floor(Number(ownedCount) || 0);
  if (Number.isFinite(max) && max > 0 && owned >= max) {
    return { error: `「${item.name || item.id}」已经养满了（上限 ${max}）`, code: "FULL" };
  }

  const balance = normalizeBubbles(save.PlayerData.bubbles);
  if (balance < price) {
    return { error: `泡泡不足，还差 ${price - balance} 个`, code: "INSUFFICIENT", short: price - balance, balance };
  }

  const category = String(item.category || "");
  if (!INVENTORY_CATEGORIES.includes(category)) {
    return { error: "商品分类不合法", code: "BAD_CATEGORY" };
  }

  const player = {
    ...save.PlayerData,
    bubbles: balance - price,
    inventory: normalizeInventory(save.PlayerData.inventory)
  };
  player.inventory[category][item.id] = owned + 1;

  return {
    save: { ...save, PlayerData: player },
    paid: price,
    balance: player.bubbles,
    ownedCount: owned + 1
  };
}

// ===== 批量结算：商店里「改完鱼缸点保存」的唯一入口 =====
//
// 为什么不能靠循环调 planPurchase：前端的商店是「自由调整鱼缸 → 点保存 → 一次性结算」，
// 一次可能同时买 2 条鱼、退还 1 个背景。循环调用不原子 —— 中途失败会留下半个鱼缸，
// 而玩家看到的是「保存失败」，实际库存已经变了。
//
// 输入是**目标鱼缸**（玩家想要的最终状态），不是「买什么」。服务端拿它和**上一次的鱼缸**对比：
//   · 鱼：按 itemId 计数。目标 > 已拥有 → 买差额；上次鱼缸里的 > 目标 → 退还差额
//   · 单选槽位（背景/沙/装饰/音效）：想用但没拥有 → 买 1 件；撤下不退（与前端行为一致）
//
// 价格、库存上限、会员限制全部由服务端裁定，客户端报的任何金额一概不采信。
// 结算规则与前端 buildSettlement 对齐 —— 前端算一次用于即时预览，服务端算一次用于落地，
// 两边不一致时以服务端为准（前端会拿服务端返回的 rows 覆盖收据）。
export function planSettlement({ save, target, items }) {
  if (!isPlainObject(save) || !isPlainObject(save.PlayerData)) {
    return { error: "还没有存档，请先完成一次同步", code: "NO_SAVE" };
  }
  if (!(items instanceof Map)) return { error: "商品配置不可用", code: "NO_ITEMS" };

  const inventory = normalizeInventory(save.PlayerData.inventory);
  const balance = normalizeBubbles(save.PlayerData.bubbles);
  const currentAquarium = isPlainObject(save.AquariumData) ? save.AquariumData : {};
  const targetAquarium = isPlainObject(target) ? target : {};

  const countFish = list => {
    const out = {};
    for (const entry of Array.isArray(list) ? list : []) {
      const id = entry && entry.itemId;
      if (id) out[id] = (out[id] || 0) + 1;
    }
    return out;
  };
  const currentFish = countFish(currentAquarium.fish);
  const targetFish = countFish(targetAquarium.fish);

  const nextInventory = normalizeInventory(inventory);
  const rows = [];
  const problems = [];
  let paid = 0;
  let refund = 0;

  // 收一笔：先做校验（会员限定 / 拥有上限），通过才计入金额与库存变更。
  const applyDelta = (item, buy, sell) => {
    const category = String(item.category || "");
    if (!INVENTORY_CATEGORIES.includes(category)) return;
    const price = Math.floor(Number(item.price));
    if (!Number.isFinite(price) || price < 0) return;
    const owned = Math.floor(Number((nextInventory[category] || {})[item.id]) || 0);

    if (buy > 0) {
      if (item.isMemberOnly === true && save.PlayerData.isMember !== true) {
        problems.push(`${item.name || item.id}为会员限定商品`);
        return;
      }
      const max = Math.floor(Number(item.maxInventory));
      if (Number.isFinite(max) && max > 0 && owned + buy > max) {
        problems.push(`${item.name || item.id}已达拥有上限（${max}）`);
        return;
      }
    }

    nextInventory[category][item.id] = Math.max(0, owned + buy - sell);
    if (buy > 0) {
      paid += buy * price;
      rows.push({ itemId: item.id, name: item.name || item.id, qty: buy, price: buy * price });
    }
    if (sell > 0) {
      refund += sell * price;
      rows.push({ itemId: item.id, name: `${item.name || item.id}返还`, qty: sell, price: -sell * price });
    }
  };

  // ① 鱼：库存是「拥有总数」，鱼缸里的条数只会 ≤ 库存。
  const fishIds = new Set([...Object.keys(currentFish), ...Object.keys(targetFish)]);
  for (const id of fishIds) {
    const item = items.get(id);
    if (!item || item.category !== "fish") continue;
    const owned = Math.floor(Number(nextInventory.fish[id]) || 0);
    const targetCount = targetFish[id] || 0;
    applyDelta(item, Math.max(0, targetCount - owned), Math.max(0, (currentFish[id] || 0) - targetCount));
  }

  // ② 单选槽位：目标里选中了但没拥有 → 买一件。撤下不退（否则可以反复买卖套利）。
  for (const [field, category] of Object.entries(SINGLE_SLOT_FIELDS)) {
    const id = targetAquarium[field];
    if (!id) continue;
    const item = items.get(id);
    if (!item || item.category !== category) continue;
    const owned = Math.floor(Number(nextInventory[category][id]) || 0);
    applyDelta(item, owned <= 0 ? 1 : 0, 0);
  }

  if (problems.length) {
    return { error: problems[0], code: "PROBLEM", problems };
  }

  const total = paid - refund;
  // 余额校验用「泡泡 + 退还」去比「应付」：退还的钱当场能抵扣。
  if (balance + refund < paid) {
    return {
      error: `泡泡不足，还差 ${paid - refund - balance} 个`,
      code: "INSUFFICIENT",
      short: paid - refund - balance,
      balance,
      paid,
      refund
    };
  }

  // 鱼缸本身仍要走一遍校验：鱼的条数不能超过结算后的库存、选中的装扮必须已拥有。
  // 这一步不能省 —— 上面的 applyDelta 只保证「库存算对了」，没保证「鱼缸摆得下」。
  const { aquarium, problems: aquariumProblems } = normalizeAquarium(
    targetAquarium,
    nextInventory,
    currentAquarium,
    { respectEmpty: true }
  );
  if (aquariumProblems.length) {
    return { error: aquariumProblems[0], code: "PROBLEM", problems: aquariumProblems };
  }

  return {
    save: {
      ...save,
      PlayerData: {
        ...save.PlayerData,
        bubbles: balance - paid + refund,
        inventory: nextInventory
      },
      AquariumData: aquarium
    },
    paid,
    refund,
    total,
    balance: balance - paid + refund,
    rows,
    problems: []
  };
}

const nowIso = () => new Date().toISOString();

// ===== 内存实现（本地开发 / 单测）=====
export function createMemoryPlayerStore({ now = () => Date.now() } = {}) {
  const users = new Map();
  const saves = new Map();
  const focusRecords = new Map();

  return {
    driver: "memory",

    async ensureUser(uid, { cohort = "public", at = now() } = {}) {
      const existing = users.get(uid);
      if (existing) {
        existing.last_seen_at = at;
        return { created: false, user: { ...existing } };
      }
      const user = {
        user_id: uid,
        sync_code_hash: "",
        nickname: "",
        cohort,
        is_supporter: false,
        supporter_note: "",
        created_at: at,
        last_seen_at: at
      };
      users.set(uid, user);
      return { created: true, user: { ...user } };
    },

    async getUser(uid) {
      const user = users.get(uid);
      return user ? { ...user } : null;
    },

    async getSave(uid) {
      const row = saves.get(uid);
      if (!row) return null;
      return { ...row, data: JSON.parse(JSON.stringify(row.data)) };
    },

    // 写入存档。data 是已经合并好的完整存档对象（调用方必须先过 mergeSaveForWrite）。
    async putSave(uid, data, { saveVersion = "", clientTs = 0, at = now() } = {}) {
      const row = { user_id: uid, data: JSON.parse(JSON.stringify(data)), save_version: saveVersion, client_ts: clientTs, updated_at: at };
      saves.set(uid, row);
      return { ...row, data: JSON.parse(JSON.stringify(row.data)) };
    },

    async addFocusRecord(record) {
      focusRecords.set(record.id, { ...record });
      return { ...record };
    },

    async settleFocusRecord(id, { countedMinutes, reward, natural, settledAt = now() }) {
      const row = focusRecords.get(id);
      if (!row) return null;
      if (row.settled_at) return { ...row, alreadySettled: true };
      Object.assign(row, { counted_minutes: countedMinutes, reward, natural, settled_at: settledAt });
      return { ...row, alreadySettled: false };
    },

    async stats(uid) {
      const rows = [...focusRecords.values()].filter(r => r.user_id === uid && r.settled_at);
      return {
        focusCount: rows.length,
        focusMinutes: rows.reduce((sum, r) => sum + (Number(r.counted_minutes) || 0), 0),
        bubblesEarned: rows.reduce((sum, r) => sum + (Number(r.reward) || 0), 0)
      };
    },

    // 仅供测试观察
    _sizes: () => ({ users: users.size, saves: saves.size, focusRecords: focusRecords.size })
  };
}

// ===== CloudBase（MySQL）实现 =====
//
// 关于 RLS / 安全规则：**不需要配**。
// 服务端用的是 CLOUDBASE_APIKEY（管理身份），本身就能绕过行级限制；
// 而玩家端从不直连数据库 —— 所有读写都经过 /api/game/* 的 HTTP 接口，
// 由接口来做身份校验与字段白名单。少一层配置就少一个「配错了但没人发现」的地方。
export function createCloudbasePlayerStore(db, { now = () => Date.now() } = {}) {
  // 查询构造器是 supabase 风格：from(table).select("*").eq(col, val).throwOnError()。
  // 所有写操作都先 select 再 insert/update —— 这个 SDK 没有原生 upsert，
  // 主键冲突时 insert 会直接报错（并发下会真的撞上，见 ensureUser 的重试）。
  const selectOne = async (table, column, value) => {
    const { data } = await db.from(table).select("*").eq(column, value).limit(1).throwOnError();
    return Array.isArray(data) ? data[0] : null;
  };

  return {
    driver: "cloudbase",

    async ensureUser(uid, { cohort = "public", at = now() } = {}) {
      const existing = await selectOne(TABLE_USERS, "user_id", uid);
      if (existing) {
        await db.from(TABLE_USERS).update({ last_seen_at: at }).eq("user_id", uid).throwOnError();
        return { created: false, user: { ...existing, last_seen_at: at } };
      }
      const row = {
        user_id: uid,
        sync_code_hash: "",
        nickname: "",
        cohort,
        is_supporter: 0,
        supporter_note: "",
        created_at: at,
        last_seen_at: at
      };
      try {
        await db.from(TABLE_USERS).insert([row], { defaultToNull: false }).throwOnError();
        return { created: true, user: row };
      } catch (error) {
        // 两台设备同时首开时，两个请求都可能 select 不到再各自 insert，其中一个必冲突。
        // 冲突说明「别人已经建好了」，这不是错误，退化成一次 update 即可。
        const again = await selectOne(TABLE_USERS, "user_id", uid);
        if (!again) throw error;
        return { created: false, user: again };
      }
    },

    async getUser(uid) {
      return selectOne(TABLE_USERS, "user_id", uid);
    },

    async getSave(uid) {
      const row = await selectOne(TABLE_SAVES, "user_id", uid);
      if (!row) return null;
      // 存档以 JSON 文本存放（LONGTEXT），不依赖数据库的 JSON 类型 ——
      // 服务端本来就要整体读写，用不上数据库侧的 JSON 查询能力，
      // 而 TEXT 在所有 MySQL 版本与形态下都一致可用。
      let data = null;
      try {
        data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      } catch {
        data = null;
      }
      return { ...row, data };
    },

    async putSave(uid, data, { saveVersion = "", clientTs = 0, at = now() } = {}) {
      const existing = await selectOne(TABLE_SAVES, "user_id", uid);
      const row = {
        user_id: uid,
        data: JSON.stringify(data),
        save_version: saveVersion,
        client_ts: clientTs,
        updated_at: at
      };
      if (existing) {
        await db.from(TABLE_SAVES).update(row).eq("user_id", uid).throwOnError();
      } else {
        try {
          await db.from(TABLE_SAVES).insert([row], { defaultToNull: false }).throwOnError();
        } catch (error) {
          const again = await selectOne(TABLE_SAVES, "user_id", uid);
          if (!again) throw error;
          await db.from(TABLE_SAVES).update(row).eq("user_id", uid).throwOnError();
        }
      }
      return { ...row, data };
    },

    async addFocusRecord(record) {
      await db.from(TABLE_FOCUS_RECORDS).insert([{
        id: record.id,
        user_id: record.user_id,
        planned_minutes: record.planned_minutes,
        counted_minutes: record.counted_minutes || 0,
        reward: record.reward || 0,
        natural: record.natural ? 1 : 0,
        started_at: record.started_at,
        settled_at: record.settled_at || 0
      }], { defaultToNull: false }).throwOnError();
      return record;
    },

    async settleFocusRecord(id, { countedMinutes, reward, natural, settledAt = now() }) {
      const row = await selectOne(TABLE_FOCUS_RECORDS, "id", id);
      if (!row) return null;
      // settled_at 非 0 表示已经结算过。防重放：同一个 sessionId 只能换一次奖励。
      if (Number(row.settled_at) > 0) return { ...row, alreadySettled: true };
      await db.from(TABLE_FOCUS_RECORDS).update({
        counted_minutes: countedMinutes,
        reward,
        natural: natural ? 1 : 0,
        settled_at: settledAt
      }).eq("id", id).throwOnError();
      return { ...row, counted_minutes: countedMinutes, reward, natural, settled_at: settledAt, alreadySettled: false };
    },

    async stats(uid) {
      const { data } = await db.from(TABLE_FOCUS_RECORDS).select("*").eq("user_id", uid).throwOnError();
      const rows = (Array.isArray(data) ? data : []).filter(r => Number(r.settled_at) > 0);
      return {
        focusCount: rows.length,
        focusMinutes: rows.reduce((sum, r) => sum + (Number(r.counted_minutes) || 0), 0),
        bubblesEarned: rows.reduce((sum, r) => sum + (Number(r.reward) || 0), 0)
      };
    }
  };
}

export async function createPlayerStore() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbasePlayerStore(await getRdb());
  return createMemoryPlayerStore();
}
