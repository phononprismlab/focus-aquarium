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
export const TABLE_TRACKING_EVENTS = "tracking_events";
// 用户档案里允许被客户端改的列。白名单写死在数据层：路由层哪怕传了别的键也写不进去，
// 免得将来有人顺手把 is_supporter / cohort 一起塞进 patch。
export const UPDATABLE_USER_FIELDS = new Set(["nickname"]);
// 昵称规则：1–12 个字符（按 Unicode 码点算，emoji 记 1 个），去掉首尾空白，
// 不允许换行/制表等控制字符。空字符串是合法值 = 清空昵称，前端会显示占位。
export const NICKNAME_MAX_LENGTH = 12;
export function normalizeNickname(input) {
  if (typeof input !== "string") return { ok: false, reason: "nickname 必须是字符串" };
  const value = input.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: "昵称不能包含换行或控制字符" };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, reason: `昵称最多 ${NICKNAME_MAX_LENGTH} 个字` };
  return { ok: true, value };
}
// 埋点白名单（定稿第三步）：open=打开页面（客户端上报）；
// focus_start / focus_complete / purchase 由服务端在权威时机直接落库，不接受客户端代报。
export const TRACKING_EVENTS = ["open", "focus_start", "focus_complete", "purchase"];

// 备份文件格式版本。`GET /api/admin/saves/export` 与本机备份脚本都读它 ——
// 以后改字段结构就升这个号，恢复脚本据此判断能不能吃下手上这份备份。
export const ARCHIVE_VERSION = 1;
// 导出用户档案时的白名单列。sync_code_hash 是凭证类数据，**不进备份文件**：
// 备份会被下载到本机磁盘、可能被转发，多带一列凭证就多一处泄漏面。
export const ARCHIVE_USER_FIELDS = ["userId", "nickname", "cohort", "isSupporter", "supporterNote", "createdAt", "lastSeenAt"];

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

// 服务端当天 00:00 的时间戳（毫秒），按服务端本地时区。
// 专注聚合的「今日」边界统一以此为准（先按服务端时区，后续要时区再调）。
function startOfTodayMs(nowFn = Date.now) {
  const d = new Date(nowFn());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 单个用户已结算的专注记录聚合。只计 settled_at > 0 的已结算记录。
function aggregateFocusStats(rows, nowFn = Date.now) {
  const settled = (Array.isArray(rows) ? rows : []).filter(r => Number(r.settled_at) > 0);
  const todayStart = startOfTodayMs(nowFn);
  const todayRows = settled.filter(r => Number(r.settled_at) >= todayStart);
  const sumMinutes = list => list.reduce((sum, r) => sum + (Number(r.counted_minutes) || 0), 0);
  return {
    focusCount: settled.length,
    focusMinutes: sumMinutes(settled),
    bubblesEarned: settled.reduce((sum, r) => sum + (Number(r.reward) || 0), 0),
    focusMinutesTotal: sumMinutes(settled),
    focusCountToday: todayRows.length,
    focusMinutesToday: sumMinutes(todayRows)
  };
}

// ===== 内存实现（本地开发 / 单测）=====
// 存档摘要：导出/恢复时用于展示「改动前后」的对比。
// 只取对人有意义的几个数 —— 差异报告是给人看的，不是给人 debug 的。
function summarizeSave(data) {
  const player = isPlainObject(data) && isPlainObject(data.PlayerData) ? data.PlayerData : {};
  const aquarium = isPlainObject(data) && isPlainObject(data.AquariumData) ? data.AquariumData : {};
  const inventory = isPlainObject(player.inventory) ? player.inventory : {};
  const ownedIn = category => Object.values(isPlainObject(inventory[category]) ? inventory[category] : {})
    .reduce((sum, n) => sum + (Number(n) || 0), 0);
  return {
    bubbles: Number(player.bubbles) || 0,
    fishInTank: Array.isArray(aquarium.fish) ? aquarium.fish.length : 0,
    ownedFish: ownedIn("fish"),
    background: String(aquarium.background || ""),
    sand: String(aquarium.sand || ""),
    decoration: String(aquarium.decoration || "")
  };
}

export function createMemoryPlayerStore({ now = () => Date.now() } = {}) {
  const users = new Map();
  const saves = new Map();
  const focusRecords = new Map();
  const trackingEvents = [];
  let trackingSeq = 0;

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

    // 局部更新用户档案（目前只有 nickname）。白名单字段，调用方传什么都不能改别的列。
    // 用户不存在时返回 null，由路由层决定是报错还是先建号。
    async updateUser(uid, patch = {}) {
      const user = users.get(uid);
      if (!user) return null;
      for (const key of Object.keys(patch)) {
        if (!UPDATABLE_USER_FIELDS.has(key)) continue;
        user[key] = patch[key];
      }
      return { ...user };
    },

    // 后台用户列表：按注册时间升序返回，并附带聚合数据（专注时长/次数、鱼数）。
    // 聚合在数据层一次性算好，避免后台页面触发「每用户一次查询」的 N+1。
    async listUsers({ cohort, isSupporter } = {}) {
      const focusByUser = new Map();
      for (const r of focusRecords.values()) {
        if (!Number(r.settled_at)) continue;
        if (!focusByUser.has(r.user_id)) focusByUser.set(r.user_id, []);
        focusByUser.get(r.user_id).push(r);
      }
      let list = [...users.values()];
      if (cohort) list = list.filter(u => u.cohort === cohort);
      if (isSupporter !== undefined) list = list.filter(u => Boolean(u.is_supporter) === isSupporter);
      list.sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
      return list.map(u => {
        const focus = aggregateFocusStats(focusByUser.get(u.user_id) || [], now);
        const save = saves.get(u.user_id);
        const fish = save && save.data && save.data.AquariumData && Array.isArray(save.data.AquariumData.fish)
          ? save.data.AquariumData.fish.length : 0;
        return {
          userId: u.user_id,
          nickname: u.nickname || "",
          cohort: u.cohort || "",
          createdAt: u.created_at || 0,
          isSupporter: Boolean(u.is_supporter),
          supporterNote: u.supporter_note || "",
          focusMinutesTotal: focus.focusMinutesTotal,
          focusCount: focus.focusCount,
          fishCount: fish
        };
      });
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
      return aggregateFocusStats(rows, now);
    },

    // 埋点落库。调用方（server.js）保证 event 已过白名单、写入失败不挡主流程。
    async addTrackingEvent({ userId, event, detail = "", at = now() } = {}) {
      const row = { id: ++trackingSeq, user_id: userId, event, detail: String(detail || ""), at };
      trackingEvents.push(row);
      return { ...row };
    },

    // 埋点概览：四个事件各给 今日 / 最近 7 天 / 累计 三个数。
    // 「今日」按服务端当天 00:00，「最近 7 天」含今天往前共 7 天。
    async trackSummary() {
      const dayStart = startOfTodayMs(now);
      const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000;
      return TRACKING_EVENTS.map(event => {
        const rows = trackingEvents.filter(r => r.event === event);
        return {
          event,
          today: rows.filter(r => r.at >= dayStart).length,
          last7d: rows.filter(r => r.at >= weekStart).length,
          total: rows.length
        };
      });
    },

    // 全量存档导出（备份用）。一次给出 users + saves 两份清单，由路由层打包成 JSON。
    // 为什么需要它：个人版没有数据回档，存档在库里被误删 / 实例故障就永久没了 ——
    // 这份导出是唯一能把存档搬出数据库实例的通道。
    async exportArchive() {
      return {
        users: [...users.values()].map(u => ({
          userId: u.user_id,
          nickname: u.nickname || "",
          cohort: u.cohort || "",
          isSupporter: Boolean(u.is_supporter),
          supporterNote: u.supporter_note || "",
          createdAt: Number(u.created_at) || 0,
          lastSeenAt: Number(u.last_seen_at) || 0
        })),
        saves: [...saves.values()].map(s => ({
          userId: s.user_id,
          saveVersion: s.save_version || "",
          clientTs: Number(s.client_ts) || 0,
          updatedAt: Number(s.updated_at) || 0,
          data: JSON.parse(JSON.stringify(s.data))
        }))
      };
    },

    // 从备份恢复存档。**刻意不走 mergeSaveForWrite** —— 备份里就是完整存档，
    // 恢复的语义是「把库里的状态退回那一刻」；合并会截断泡泡、忽略客户端 inventory，
    // 等于把要恢复的东西又改一遍。
    // updated_at 一律写**当前时间**：玩家端 syncCloudSave 用 `remoteUpdatedAt > lastPushedAt`
    // 决定该不该采用云端，写回旧时间戳的话玩家下次打开会用本地存档覆盖回去，恢复白做。
    async restoreSaves(entries, { dryRun = true, at = now() } = {}) {
      const items = [];
      const rollback = [];
      for (const entry of entries) {
        const userId = String((entry && entry.userId) || "");
        if (!userId) { items.push({ userId: "", action: "skipped", reason: "缺 userId" }); continue; }
        if (!isPlainObject(entry.data)) { items.push({ userId, action: "skipped", reason: "data 不是对象（备份可能损坏）" }); continue; }
        const existing = saves.get(userId);
        const before = existing ? JSON.parse(JSON.stringify(existing.data)) : null;
        const after = JSON.parse(JSON.stringify(entry.data));
        if (before && JSON.stringify(before) === JSON.stringify(after)) {
          items.push({ userId, action: "unchanged", before: summarizeSave(before), after: summarizeSave(after) });
          continue;
        }
        items.push({
          userId,
          action: before ? "update" : "create",
          before: before ? summarizeSave(before) : null,
          after: summarizeSave(after)
        });
        if (!dryRun) {
          saves.set(userId, {
            user_id: userId,
            data: after,
            save_version: String(entry.saveVersion || ""),
            client_ts: Number(entry.clientTs) || 0,
            updated_at: at
          });
          // 回滚快照：只记「被覆盖掉的旧存档」。create 没有旧值，无从回滚。
          if (before) {
            rollback.push({
              userId,
              saveVersion: existing.save_version || "",
              clientTs: Number(existing.client_ts) || 0,
              data: before
            });
          }
        }
      }
      return { items, rollback };
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

    // 局部更新用户档案（目前只有 nickname）。白名单在数据层兜底，
    // 空 patch 直接读回原行，避免发一条 update {} 的空语句。
    // 用 selectOne 回读而不是把 update 的返回当行 —— 这个 SDK 的 update 不回填行。
    async updateUser(uid, patch = {}) {
      const row = {};
      for (const key of Object.keys(patch)) {
        if (!UPDATABLE_USER_FIELDS.has(key)) continue;
        row[key] = patch[key];
      }
      if (!Object.keys(row).length) return selectOne(TABLE_USERS, "user_id", uid);
      await db.from(TABLE_USERS).update(row).eq("user_id", uid).throwOnError();
      return selectOne(TABLE_USERS, "user_id", uid);
    },

    // 后台用户列表：按注册时间升序返回，并附带聚合数据（专注时长/次数、鱼数）。
    // 三趟查询（users / focus_records / saves）一次性拉回，按 user_id 在内存里聚合，
    // 不论用户多少都只有这三次查询，不触发 N+1。
    // ⚠️ 只用 select("*")/eq/throwOnError 这套已在线上验证过的 SDK 面貌：
    //    这个查询构造器没有 order 方法（也没有验证过列名列表 select），
    //    排序与列裁剪都在 JS 侧做 —— 用户量级（几百）下这点开销可以忽略。
    async listUsers({ cohort, isSupporter } = {}) {
      let q = db.from(TABLE_USERS).select("*");
      if (cohort) q = q.eq("cohort", cohort);
      if (isSupporter !== undefined) q = q.eq("is_supporter", isSupporter ? 1 : 0);
      const { data: userRows } = await q.throwOnError();
      const { data: focusRows } = await db.from(TABLE_FOCUS_RECORDS).select("*").throwOnError();
      const { data: saveRows } = await db.from(TABLE_SAVES).select("*").throwOnError();
      const focusByUser = new Map();
      for (const r of (focusRows || [])) {
        if (!Number(r.settled_at)) continue;
        if (!focusByUser.has(r.user_id)) focusByUser.set(r.user_id, []);
        focusByUser.get(r.user_id).push(r);
      }
      const fishByUser = new Map();
      for (const s of (saveRows || [])) {
        let d = s.data;
        if (typeof d === "string") { try { d = JSON.parse(d); } catch { d = null; } }
        const fish = d && d.AquariumData && Array.isArray(d.AquariumData.fish) ? d.AquariumData.fish.length : 0;
        fishByUser.set(s.user_id, fish);
      }
      return (userRows || [])
        .slice()
        .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0))
        .map(u => {
          const focus = aggregateFocusStats(focusByUser.get(u.user_id) || [], now);
          return {
            userId: u.user_id,
            nickname: u.nickname || "",
            cohort: u.cohort || "",
            createdAt: u.created_at || 0,
            isSupporter: Boolean(u.is_supporter === true || u.is_supporter === 1),
            supporterNote: u.supporter_note || "",
            focusMinutesTotal: focus.focusMinutesTotal,
            focusCount: focus.focusCount,
            fishCount: fishByUser.get(u.user_id) || 0
          };
        });
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
      const { data } = await db.from(TABLE_FOCUS_RECORDS).select("counted_minutes,settled_at,reward").eq("user_id", uid).throwOnError();
      return aggregateFocusStats(data, now);
    },

    // 埋点落库。id 由应用层生成：控制台表单建不了 bigserial，tracking_events.id
    // 按 varchar 主键建（2026-09-24 实测），字符串 id 与 at 排序够用，V1.0 量级下
    // 同毫秒碰撞概率可忽略。id 长度约 23 字符，列长 ≥32 即可。
    async addTrackingEvent({ userId, event, detail = "", at = now() } = {}) {
      const id = `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await db.from(TABLE_TRACKING_EVENTS).insert([{ id, user_id: userId, event, detail: String(detail || ""), at }], { defaultToNull: false }).throwOnError();
      return { id, user_id: userId, event, detail: String(detail || ""), at };
    },

    // 埋点概览：一次性拉回 event/at 在 JS 里聚合（同 listUsers 的取舍 ——
    // 只用已验证的 select("*") 面貌；V1.0 量级下全表聚合开销可忽略）。
    async trackSummary() {
      const { data } = await db.from(TABLE_TRACKING_EVENTS).select("*").throwOnError();
      const dayStart = startOfTodayMs(now);
      const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000;
      return TRACKING_EVENTS.map(event => {
        const rows = (data || []).filter(r => r.event === event);
        return {
          event,
          today: rows.filter(r => Number(r.at) >= dayStart).length,
          last7d: rows.filter(r => Number(r.at) >= weekStart).length,
          total: rows.length
        };
      });
    },

    // 全量存档导出（备份用）。两趟查询拿全 users + saves，字段裁剪与列名映射都在 JS 侧
    // 做（同 listUsers 的取舍：只用线上验证过的 select("*") 面貌，不做列名列表 select）。
    // 用户量级（几百）下这两次全表扫描的开销可忽略；真要上万再谈分页导出。
    async exportArchive() {
      const { data: userRows } = await db.from(TABLE_USERS).select("*").throwOnError();
      const { data: saveRows } = await db.from(TABLE_SAVES).select("*").throwOnError();
      return {
        users: (userRows || []).map(u => ({
          userId: u.user_id,
          nickname: u.nickname || "",
          cohort: u.cohort || "",
          isSupporter: Boolean(u.is_supporter === true || u.is_supporter === 1),
          supporterNote: u.supporter_note || "",
          createdAt: Number(u.created_at) || 0,
          lastSeenAt: Number(u.last_seen_at) || 0
        })),
        saves: (saveRows || []).map(s => {
          // data 是 JSON 文本。解析成功就给对象（备份文件人能读），解析失败保留原文 ——
          // 备份的职责是忠实，不是纠正。恢复时按类型分别处理。
          let data = s.data;
          if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* 保留原文 */ } }
          return {
            userId: s.user_id,
            saveVersion: s.save_version || "",
            clientTs: Number(s.client_ts) || 0,
            updatedAt: Number(s.updated_at) || 0,
            data
          };
        })
      };
    },

    // 从备份恢复存档。理由同内存版：不走 mergeSaveForWrite、updated_at 写当前时间。
    // ⚠️ 用 this.putSave 复用已有的 upsert（含「insert 撞主键就改 update」的竞态兜底），
    //    所以必须走 store.restoreSaves(...) 调用，别把方法解构出来单独用。
    async restoreSaves(entries, { dryRun = true, at = now() } = {}) {
      const items = [];
      const rollback = [];
      for (const entry of entries) {
        const userId = String((entry && entry.userId) || "");
        if (!userId) { items.push({ userId: "", action: "skipped", reason: "缺 userId" }); continue; }
        if (!isPlainObject(entry.data)) { items.push({ userId, action: "skipped", reason: "data 不是对象（备份可能损坏）" }); continue; }
        const existing = await selectOne(TABLE_SAVES, "user_id", userId);
        let before = null;
        if (existing) {
          before = existing.data;
          if (typeof before === "string") { try { before = JSON.parse(before); } catch { before = null; } }
        }
        const after = JSON.parse(JSON.stringify(entry.data));
        if (before && JSON.stringify(before) === JSON.stringify(after)) {
          items.push({ userId, action: "unchanged", before: summarizeSave(before), after: summarizeSave(after) });
          continue;
        }
        items.push({
          userId,
          action: before ? "update" : "create",
          before: before ? summarizeSave(before) : null,
          after: summarizeSave(after)
        });
        if (!dryRun) {
          await this.putSave(userId, after, {
            saveVersion: String(entry.saveVersion || ""),
            clientTs: Number(entry.clientTs) || 0,
            at
          });
          if (before) {
            rollback.push({
              userId,
              saveVersion: existing.save_version || "",
              clientTs: Number(existing.client_ts) || 0,
              data: before
            });
          }
        }
      }
      return { items, rollback };
    }
  };
}

export async function createPlayerStore() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbasePlayerStore(await getRdb());
  return createMemoryPlayerStore();
}
