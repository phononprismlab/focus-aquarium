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
//   🔀 客户端只能减、服务端只能加
//      PlayerData.bubbles      —— 客户端提交值只用于**下调**（买东西要推更小的余额），
//                                 上浮一律以服务端现值为准。见 PLAYER_FIELDS.bubbles 的注释。
//
//   🟢 客户端权威（接受客户端值，只做范围钳制）
//      AquariumData.*           —— 鱼缸布局：选中哪条鱼、哪个背景/沙/装饰/音效
//      Settings.*               —— 音量等偏好
//
// ===== 泡泡是怎么变成服务端权威的 =====
//
// 旧规则是 `min(提交值, 服务端值 + 2000)` —— 只挡单次增量、不挡次数，循环 push 就能刷。
// 现在客户端提交值只用于下调，任何上浮都由服务端经手的事落账，且一律走 grants：
//
//   专注奖励   focus/complete 结算完写一条 grant
//   事件奖励   POST /api/game/events/reward，服务端校验冷却 + 每日上限后写一条 grant
//   运营奖励   后台 /api/admin/grants
//
// 🔴 为什么统统走 grants 而不是直接写 saves.bubbles：写完玩家下一次 push 会把更小的
//    本地值推上来，`Math.min` 一夹，奖励就蒸发了。grants 是在 merge **之后**叠加的，
//    天然免疫这个夹逼（这也是当初发运营奖励时踩出来的坑）。
//
// 事件奖励的强度边界（有意为之，不是遗漏）：事件的**触发判定仍在前端**（5s 心跳、
// 概率也配在前端），服务端不复现触发条件 —— 它只强制「冷却 + 每日上限」这两个配置里
// 本来就有的约束。所以伪造一次事件最多拿到「配置允许的那份」，刷不出无限泡泡。
// 要再进一步就得把整套事件检测搬到服务端（含服务端随机），收益与成本不成比例。
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
// 待发放 / 已发放的奖励。**这是泡泡唯一的合法增长入口** —— 运营奖励、专注奖励、
// 事件奖励都落在这里，再由结算协议在 merge **之后**叠加到存档上（见 grants 相关实现）。
//
// 为什么不直接改 saves.bubbles：存档是前端推上来的整包，客户端提交值能把服务端加上的
// 泡泡夹回去（`Math.min`），直接写进去的奖励会被下一次 push 覆盖掉。
//
// 附带用途：这张表同时被当作**事件奖励的冷却账本** —— 每发一次事件奖励就留一行
// `reason = "event:<id>"`，行数与时间戳就是「今天发过几次、上次什么时候发的」。
// 因此查询它时必须按 reason 精确匹配（见 queryGrants）。
export const TABLE_GRANTS = "grants";
// 玩家反馈（设置里的「联系我们」表单）。**这是玩家自己写的文本，不是配置** ——
// 后台只读不改（只标记处理状态），所以它属于玩家数据表，不进 fishtank_configs 那张配置单表。
//
// 为什么要有 contact 这一列而不是只存正文：玩家往往不留联系方式，但一旦留了，
// 这条留言的价值就完全不同（能回访）。所以它单独成列，后台列表里能一眼看到。
// 🔴 这一列是**玩家自己填的、可能包含个人信息的文本** —— 自助注销必须把它一起删掉
//    （见 deleteUser），否则「删除你的全部数据」这句话不成立。
export const TABLE_FEEDBACK = "feedback";
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

// 泡泡绝对值上限。任何一条加法（发放 / 结算 / 首次同步）都套这个帽子，
// 防的是「手滑多打几个 0」和脏数据，不是防作弊 —— 防作弊靠的是「客户端不能加」。
export const MAX_BUBBLES = 1_000_000_000;

// ===== 首次同步的上限（首 push 服务端没有基线，但不能因此就成了无底洞）=====
// 首次同步时服务端确实只能以玩家本地存档为准（进度只存在于他的浏览器里），
// 但「一个新账号能有多少东西」是有常识范围的，所以首 push 也要按这个范围归一：
//
//   · 泡泡：一次 25 分钟专注给 25 个，玩一天几百个；离线攒上两周也到不了 5000。
//     ⚠️ 这只是把「一次请求能写进来多少」变成**有界**（以前是 1e9 直接进），
//     防不住玩家慢慢攒 —— 泡泡终究是客户端权威，真正的收紧见文件头那段欠账说明。
//   · 库存：鱼的 maxInventory 是 50，其余四个分类都是单选槽位（买一件就够用）。
//     所以分别钳到 50 / 1。**不能一刀清零** —— 纯本地模式下玩家真的离线买过东西，
//     清零会把他的真实进度抹掉。
export const FIRST_PUSH_MAX_BUBBLES = 5000;
export const FIRST_PUSH_MAX_FISH_PER_ITEM = 50;
export const FIRST_PUSH_MAX_SINGLE_SLOT = 1;

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

// 首次同步的库存归一：先走一遍通用清洗，再按分类钳到常识上限。
// 返回 { inventory, problems } —— problems 只进日志与单测，不下发给玩家。
export function normalizeInventoryForFirstPush(value) {
  const source = normalizeInventory(value);
  const problems = [];
  const result = {};
  for (const category of INVENTORY_CATEGORIES) {
    const cap = category === "fish" ? FIRST_PUSH_MAX_FISH_PER_ITEM : FIRST_PUSH_MAX_SINGLE_SLOT;
    const clean = {};
    for (const [id, count] of Object.entries(source[category])) {
      if (count > cap) {
        problems.push(`首次同步库存 ${category}/${id} 超过上限（${count} → ${cap}），已钳制`);
        clean[id] = cap;
      } else {
        clean[id] = count;
      }
    }
    result[category] = clean;
  }
  return { inventory: result, problems };
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

// ===== 玩家反馈（「联系我们」表单）=====
// 留言上限。1000 个码点足够把问题说清楚，又不至于让人往库里灌小作文。
export const FEEDBACK_MESSAGE_MAX = 1000;
// 联系方式上限。这里刻意不做格式校验（不强制邮箱、不收手机号）——
// 玩家想留微信号、QQ 号、邮箱、甚至「站内回复就行」都行，是**他选**怎么被联系。
export const FEEDBACK_CONTACT_MAX = 120;
// 后台能标记的状态。`new` = 还没人看过；`read` = 看过了；`done` = 处理完了。
export const FEEDBACK_STATUSES = ["new", "read", "done"];
// 控制字符会破坏后台列表与日志的可读性，一律剥掉；但 \t(0x09) 与 \n(0x0a) 留着 ——
// 留言是多行文本框，换行是玩家排版的一部分。
const stripControlChars = value => String(value == null ? "" : value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

// 归一化一条留言。返回 { ok, contact, message } 或 { ok:false, reason }。
// 只做「形状 + 长度 + 控制字符」三件事，不猜玩家想说什么。
export function normalizeFeedback({ contact, message } = {}) {
  // 先卡类型：数字 / 对象进来会一路走到 String() 变成 "[object Object]" 存进库里，
  // 那种留言后台看不懂、也回访不了，不如在门口拒掉。
  const rawMessage = message === undefined || message === null ? "" : message;
  const rawContact = contact === undefined || contact === null ? "" : contact;
  if (typeof rawMessage !== "string") return { ok: false, reason: "留言内容必须是文本" };
  if (typeof rawContact !== "string") return { ok: false, reason: "联系方式必须是文本" };

  const cleanMessage = stripControlChars(rawMessage).replace(/\n{4,}/g, "\n\n\n").trim();
  // 联系方式压成一行：里面混进换行会让后台表格排版崩掉，且联系方式本来就不该多行。
  const cleanContact = stripControlChars(rawContact).replace(/\s+/g, " ").trim();
  if (!cleanMessage) return { ok: false, reason: "留言内容不能为空" };
  if ([...cleanMessage].length > FEEDBACK_MESSAGE_MAX) {
    return { ok: false, reason: `留言最多 ${FEEDBACK_MESSAGE_MAX} 个字` };
  }
  if ([...cleanContact].length > FEEDBACK_CONTACT_MAX) {
    return { ok: false, reason: `联系方式最多 ${FEEDBACK_CONTACT_MAX} 个字` };
  }
  return { ok: true, contact: cleanContact, message: cleanMessage };
}

// 反馈行 id。与 grants / tracking_events 同一套「应用层生成字符串主键」的理由：
// 控制台的可视化建表建不出 bigserial。
export function feedbackId() {
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

// ===== PlayerData 字段注册表 =====
//
// mergeSaveForWrite 按这张表重建 PlayerData。**表里没注册的键一律丢弃** ——
// 客户端塞不进任何没登记的东西（防脏数据的第一道闸）。
//
// 为什么要有这张表：以前 merge 是硬编码三个键，加第四个字段（图鉴 / 成就 / 连续打卡…）
// 会被**静默丢掉**。而且丢在服务端还不够 —— 前端 applyCloudSave 用 replaceContents
// （先清空再写入），会把本地那份也一起抹掉，表现成「本地解锁了、一联网就归零」，全程无报错。
//
// 每个字段声明三件事：
//   source  「以谁为准」：client = 客户端提交的算数（图鉴解锁）
//                        server = 服务端已存的算数（库存、会员，客户端改不动）
//                        ⚠️ bubbles 是个特例：**客户端只能减、服务端只能加**（见那条的注释），
//                        它标 client 是因为「客户端提交的值要参与计算」，不是因为客户端权威。
//   merge   (server, client, { firstPush, problems }) => 归一后的值
//   signed  是否纳入本机存档签名（见 index.html 的 computeSaveSignature）
//
// 🔴 加新字段的完整步骤（少一步就出问题）：
//   ① 在这里注册一条，写清 merge 归一 —— 别信客户端提交的形状
//   ② 前端 migrateData() 里补默认值（老存档没有这个键）
//   ③ signed:true 的字段必须**同时**升签名版本 + 写迁移：签名算法一变，
//      所有老存档都算不出匹配的签名 → 被判 tampered → 泡泡清零。
//      test/player-field-registry.test.js 会盯着这条，别绕过去。
export const PLAYER_FIELDS = {
  // 🔴 泡泡：客户端**只能减，不能加**。
  //
  // 旧规则是 `Math.min(提交值, 服务端值 + 2000)`，注释里就写着「这不是安全边界」——
  // 它只挡单次增量，挡不住次数：攻击者循环 PUT /api/game/save、每次报「当前 +2000」，
  // 一秒几十次就是无限泡泡，根本不用真的专注。现在改成客户端提交值只用于**下调**
  // （买完要推更小的值），任何上浮一律以服务端现值为准。
  //
  // 那泡泡怎么增加？**只能由服务端经手的事落账**，而且必须走 grants 协议：
  //   专注奖励   focus/complete 结算完写一条 grant
  //   事件奖励   POST /api/game/events/reward 校验冷却与每日上限后写一条 grant
  //   运营奖励   后台 /api/admin/grants
  // 为什么不能「服务端直接写 saves.bubbles」：写完玩家下一次 push 会把更小的本地值
  // 推上来，`Math.min` 一夹，奖励就蒸发了。grants 是在 merge **之后**叠加的，天然免疫。
  bubbles: {
    source: "client",
    signed: true,
    merge: (server, client, { firstPush, problems }) => {
      const submitted = normalizeBubbles(client.bubbles);
      if (firstPush) {
        // 首次同步：玩家的进度确实只在他的浏览器里，服务端没有依据可核对，
        // 若强行从 0 开始等于把历史进度抹掉。但「以本地为准」不等于「来者不拒」——
        // 按新账号的常识范围封顶（T3-9 之前这里能一次写进 1e9）。
        // ⚠️ 这条通道是有界的作弊面：注册新号最多写进 FIRST_PUSH_MAX_BUBBLES 个泡泡，
        //    之后就只能靠服务端落账了。V1.0 泡泡不对应任何现实价值，这个上界可接受。
        const capped = Math.min(submitted, FIRST_PUSH_MAX_BUBBLES);
        if (submitted > capped) {
          problems.push(`首次同步泡泡超过新账号上限（提交 ${submitted} → ${FIRST_PUSH_MAX_BUBBLES}），已截断`);
        }
        return capped;
      }
      const serverBubbles = normalizeBubbles(server.bubbles);
      if (submitted > serverBubbles) {
        problems.push(`泡泡只允许服务端增加（服务端 ${serverBubbles} → 提交 ${submitted}），增量已忽略`);
      }
      return Math.min(submitted, serverBubbles);
    }
  },
  isMember: {
    source: "server",
    signed: true,
    merge: server => server.isMember === true
  },
  inventory: {
    source: "server",
    signed: true,
    merge: (server, client, { firstPush, problems }) => {
      if (!firstPush) return normalizeInventory(server.inventory);
      const { inventory, problems: inventoryProblems } = normalizeInventoryForFirstPush(client.inventory);
      problems.push(...inventoryProblems);
      return inventory;
    }
  }
};

// 存档合并的**唯一入口**。stored 为 null 表示这个账号还没有存档（首次同步）。
export function mergeSaveForWrite(stored, incoming, { saveVersion = "" } = {}) {
  const problems = [];
  const incomingSave = isPlainObject(incoming) ? incoming : {};
  const incomingPlayer = isPlainObject(incomingSave.PlayerData) ? incomingSave.PlayerData : {};
  const hasStored = isPlainObject(stored) && isPlainObject(stored.PlayerData);
  const firstPush = !hasStored;
  const serverPlayer = hasStored ? stored.PlayerData : {};

  // 客户端提交了「服务端权威」的字段 → 记一条，便于排查「我明明改了怎么没生效」。
  // 首次同步不记：那一步本来就是以客户端为准，不存在「被忽略」。
  if (!firstPush) {
    for (const [key, rule] of Object.entries(PLAYER_FIELDS)) {
      if (rule.source === "server" && key in incomingPlayer) {
        problems.push(`忽略了客户端提交的 PlayerData.${key}`);
      }
    }
  }

  // 按注册表重建。加字段只需在 PLAYER_FIELDS 里注册，这里不用动。
  const player = {};
  for (const [key, rule] of Object.entries(PLAYER_FIELDS)) {
    player[key] = rule.merge(serverPlayer, incomingPlayer, { firstPush, problems });
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

    // 🔴 退款只能按「实际持有」结算：sell 有时是按**鱼缸条数**算的（撤下鱼），
    // 而缸内条数可能因首次同步注入等原因大于库存 —— 那时直接按 sell 退钱会凭空造泡泡。
    // 真正能卖掉的至多是本轮可用的量（原有 + 本次买入），超出的部分没有东西可退。
    const realSell = Math.min(sell, owned + buy);
    nextInventory[category][item.id] = Math.max(0, owned + buy - realSell);
    if (buy > 0) {
      paid += buy * price;
      rows.push({ itemId: item.id, name: item.name || item.id, qty: buy, price: buy * price });
    }
    if (realSell > 0) {
      refund += realSell * price;
      rows.push({ itemId: item.id, name: `${item.name || item.id}返还`, qty: realSell, price: -realSell * price });
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

// ===== 运营奖励：发放 + 结算 =====
//
// 为什么奖励不能直接写进 saves.bubbles（本模块最容易踩的坑）：
//   mergeSaveForWrite 对泡泡是「客户端权威 + 增长上限」—— 客户端提交的是**绝对值**，
//   只要不超过「服务端现值 + 2000」就全盘接受，**包括比服务端现值更小的情况**
//   （购买后本来就要推更小值，cloud-save.test.js 有一条断言专门守着这个行为）。
//   所以服务端悄悄加进去的泡泡会被玩家下一次 push 覆盖回去，奖励凭空蒸发。
//
// 协议：奖励先落成 grants 行（claimed_at = 0 = 待领取），结算时
//       读存档 → 【合并结果之后】叠加待领取的 grants → 写回 → 标记 claimed_at。
//       叠加必须在 merge 之后 —— 先加再 merge 会被客户端更小的泡泡值夹掉。
export const GRANT_BUBBLES_MAX = 100000;      // 单次发放上限：防手滑多打一个 0
export const GRANT_ITEMS_MAX = 20;            // 单次最多发几种物品
export const GRANT_QTY_MAX = 999;             // 单种物品的数量上限
export const GRANT_REASON_MAX_LENGTH = 200;

// items 的形状：数组，每项 { id, category, qty }。
// category 在**发放时**就由服务端从已发布配置解析并固化下来：
//   ① 结算发生在 push 热路径上，那时再读一次配置既慢又多一个失败点；
//   ② 固化下来也留下了「当初到底发了什么」的审计线索。
export function normalizeGrantItems(input) {
  if (input === undefined || input === null) return { ok: true, items: [] };
  if (!Array.isArray(input)) return { ok: false, reason: "items 必须是数组" };
  if (input.length > GRANT_ITEMS_MAX) return { ok: false, reason: `一次最多发 ${GRANT_ITEMS_MAX} 种物品` };
  const merged = new Map();
  for (const entry of input) {
    if (!isPlainObject(entry)) return { ok: false, reason: "items 的每一项都必须是对象" };
    const id = String(entry.id || "").trim();
    if (!id) return { ok: false, reason: "items 里有一项没有 id" };
    if (id.length > 64) return { ok: false, reason: "物品 id 过长" };
    const category = String(entry.category || "").trim();
    if (!INVENTORY_CATEGORIES.includes(category)) {
      return { ok: false, reason: `物品 ${id} 的分类不合法（应为 ${INVENTORY_CATEGORIES.join(" / ")}）` };
    }
    const qty = Math.floor(Number(entry.qty));
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: `物品 ${id} 的数量必须是正整数` };
    if (qty > GRANT_QTY_MAX) return { ok: false, reason: `物品 ${id} 的数量超过上限（${GRANT_QTY_MAX}）` };
    const key = `${category}:${id}`;
    const existing = merged.get(key);
    merged.set(key, { id, category, qty: (existing ? existing.qty : 0) + qty });
  }
  return { ok: true, items: [...merged.values()] };
}

// 读一行 grants 的 items。库里存的是 JSON 文本（内存实现直接给数组）。
// 解析失败返回空数组 —— 存档侧不该因为一行坏 JSON 崩掉，泡泡照发、物品丢掉。
export function parseGrantItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 空数组存成空串而不是 "[]" —— 与 schema 的 DEFAULT '' 保持一致，读的时候不用分支。
export function serializeGrantItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.length ? JSON.stringify(list) : "";
}

// 把一批 grants 叠加到存档上。**纯函数**，返回新存档 + 本次实际到手的明细。
// 🔴 调用方必须在 mergeSaveForWrite 之后调用它（见本段开头）。
export function applyGrants(save, grants) {
  const list = Array.isArray(grants) ? grants : [];
  const base = isPlainObject(save) ? save : {};
  const player = isPlainObject(base.PlayerData) ? base.PlayerData : defaultPlayer({});
  const balance = normalizeBubbles(player.bubbles);
  if (!list.length) return { save: base, bubbles: 0, items: [], balance, changed: false };

  const inventory = normalizeInventory(player.inventory);
  let bubbles = balance;
  let addedBubbles = 0;
  const addedItems = [];

  for (const grant of list) {
    const add = normalizeBubbles(grant && grant.bubbles);
    if (add > 0) {
      const before = bubbles;
      // 走一遍 normalizeBubbles 是为了套上 MAX_BUBBLES 上限；
      // 计数用「实际到手的差额」而不是 add，否则小票上的数字会比真实余额大。
      bubbles = normalizeBubbles(bubbles + add);
      addedBubbles += bubbles - before;
    }
    for (const entry of parseGrantItems(grant && grant.items)) {
      if (!isPlainObject(entry)) continue;
      const id = String(entry.id || "");
      const category = String(entry.category || "");
      if (!id || !INVENTORY_CATEGORIES.includes(category)) continue;
      const qty = Math.floor(Number(entry.qty));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      inventory[category][id] = Math.floor(Number(inventory[category][id]) || 0) + qty;
      addedItems.push({ id, category, qty });
    }
  }

  if (addedBubbles <= 0 && !addedItems.length) {
    return { save: base, bubbles: 0, items: [], balance, changed: false };
  }
  return {
    save: { ...base, PlayerData: { ...player, bubbles, inventory } },
    bubbles: addedBubbles,
    items: addedItems,
    balance: bubbles,
    changed: true
  };
}

const nowIso = () => new Date().toISOString();


// 服务端当天 00:00 的时间戳（毫秒），按服务端本地时区。
// 专注聚合与事件奖励每日上限的「今日」边界统一以此为准（先按服务端时区，后续要时区再调）。
export function startOfTodayMs(nowFn = Date.now) {
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
  const grants = new Map();
  const trackingEvents = [];
  const feedback = new Map();
  let trackingSeq = 0;

  return {
    driver: "memory",

    // readiness 探针用：内存实现没有外部依赖，永远算通。
    // 返回结构刻意与云实现一致，探针那边不用分支判断。
    async ping() {
      return { ok: true, driver: "memory" };
    },

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
    // 内存实现同样支持乐观锁，语义与云实现一致（否则单测覆盖不到真机的行为）。
    async putSave(uid, data, { saveVersion = "", clientTs = 0, at = now(), expectUpdatedAt = null } = {}) {
      const current = saves.get(uid);
      if (expectUpdatedAt !== null) {
        const currentVersion = current ? Number(current.updated_at) || 0 : 0;
        if (currentVersion !== Number(expectUpdatedAt)) {
          return { conflict: true, currentUpdatedAt: currentVersion };
        }
      }
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
      // ⚠️ 判据必须是 `> 0`：claimFocusSession 已经把 settled_at 置成**负数**哨兵了，
      //    那是「已认领、还没写结算结果」，不是「已结算」—— 写成「非 0 就返回」会把补写拦掉。
      const wasSettled = Number(row.settled_at) > 0;
      if (wasSettled) return { ...row, alreadySettled: true };
      Object.assign(row, { counted_minutes: countedMinutes, reward, natural, settled_at: settledAt });
      return { ...row, alreadySettled: false };
    },

    // ===== 专注会话持久层（跨实例 / 跨重启结算用）=====
    // 内存实现里这三件事本来就成立 —— 它天然是"共享"的，因为整台机器只有一份。
    // 接口与云实现保持一致，focus-session.js 不用分支判断。
    async findFocusSession(id) {
      return focusRecords.get(id) || null;
    },

    async claimFocusSession(id) {
      const row = focusRecords.get(id);
      if (!row) return false;
      if (row.settled_at) return false;
      row.settled_at = -1; // 负数哨兵：与 cloud 版一致（见那边 claimFocusSession 的说明）
      return true;
    },

    async stats(uid) {
      // 与 cloud 版 aggregateFocusStats 同一判据（`> 0` = 真正结算过），负数哨兵不算。
      const rows = [...focusRecords.values()].filter(r => r.user_id === uid && Number(r.settled_at) > 0);
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

    // ===== 玩家反馈（设置里的「联系我们」）=====
    // 玩家写、后台读。这里没有 merge / 权威性可言 —— 它不参与经济，改不了任何游戏状态，
    // 所以整条链路刻意做得很薄：落一行、按状态列出来、标一下状态、能删。
    async addFeedback({ id, userId = "", nickname = "", contact = "", message = "", at = now() } = {}) {
      const row = {
        id,
        user_id: String(userId || ""),
        nickname: String(nickname || ""),
        contact: String(contact || ""),
        message: String(message || ""),
        status: "new",
        created_at: at,
        handled_at: 0
      };
      feedback.set(row.id, row);
      return { ...row };
    },

    async listFeedback({ status = "", limit = 200 } = {}) {
      let list = [...feedback.values()];
      if (status) list = list.filter(f => f.status === status);
      list.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
      return list.slice(0, Math.max(0, limit)).map(f => ({ ...f }));
    },

    // 标记处理状态。status 回到 "new" 时把 handled_at 清 0 ——
    // 否则后台「已处理」列表里会出现一条「未处理但带处理时间」的怪行。
    async setFeedbackStatus(id, status, { at = now() } = {}) {
      const row = feedback.get(String(id || ""));
      if (!row) return null;
      row.status = status;
      row.handled_at = status === "new" ? 0 : at;
      return { ...row };
    },

    async deleteFeedback(ids) {
      let removed = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        if (feedback.delete(String(id || ""))) removed++;
      }
      return removed;
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

    // ===== 运营奖励（发放 / 认领 / 退回）=====
    // 内存实现天然串行，"条件更新"退化成一次读一次写 —— 接口形状与云实现一致，
    // 路由层不用分支判断。
    async addGrants(rows) {
      const created = [];
      for (const row of rows) {
        const record = {
          id: row.id,
          user_id: row.user_id,
          bubbles: Math.floor(Number(row.bubbles) || 0),
          items: typeof row.items === "string" ? row.items : serializeGrantItems(row.items),
          reason: String(row.reason || ""),
          created_at: row.created_at,
          claimed_at: 0
        };
        grants.set(record.id, record);
        created.push({ ...record });
      }
      return created;
    },

    async listGrants({ userId = "", limit = 200 } = {}) {
      let list = [...grants.values()];
      if (userId) list = list.filter(g => g.user_id === userId);
      list.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
      return list.slice(0, Math.max(0, limit)).map(g => ({ ...g }));
    },

    // 按 reason 精确统计「某人在某段时间内领过几次、最后一次是什么时候」。
    // 事件奖励的冷却与每日上限靠它 —— grants 表本身就是账本，不另建表。
    async queryGrants({ userId = "", reason = "", since = 0 } = {}) {
      let count = 0;
      let lastAt = 0;
      for (const row of grants.values()) {
        if (userId && row.user_id !== userId) continue;
        if (reason && row.reason !== reason) continue;
        const at = Number(row.created_at) || 0;
        if (at < since) continue;
        count++;
        if (at > lastAt) lastAt = at;
      }
      return { count, lastAt };
    },

    // 认领该玩家所有待领取的奖励（claimed_at = 0 → at），返回**本次真的认领到**的行。
    // 返回空数组 = 没有待领取的，调用方直接跳过写存档。
    async claimPendingGrants(uid, { at = now() } = {}) {
      const claimed = [];
      for (const row of grants.values()) {
        if (row.user_id !== uid) continue;
        if (Number(row.claimed_at)) continue;
        row.claimed_at = at;
        claimed.push({ ...row });
      }
      return claimed;
    },

    // 补偿：把认领过的行退回「未领取」。
    // 只在「已认领但存档没写成」时调用 —— 否则这条奖励会永久卡在已领取状态，玩家再也拿不到。
    // 只退回 claimed_at 仍等于本次认领值的行，避免误退别人刚认领的。
    async releaseGrants(ids, { claimedAt } = {}) {
      let released = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        const row = grants.get(id);
        if (!row || Number(row.claimed_at) !== Number(claimedAt)) continue;
        row.claimed_at = 0;
        released++;
      }
      return released;
    },

    // ===== 自助注销：删掉这个人的全部数据 =====
    // 6 张表按 user_id 全删。
    //
    // 为什么是硬删而不是标个 deleted 字段：隐私政策写的是「删除」，数据留在库里
    // 只改个标记，严格说不构成删除。而这些表里没有需要留档的东西（无交易、无支付），
    // 留着只是负担。代价是不可恢复 —— 所以前端必须二次确认，且运维侧靠备份兜底。
    //
    // 🔴 uid 必须是非空字符串：focus_records.user_id 有默认值 ''（未登录也能专注），
    //    空串 uid 会把**所有未登录玩家**的专注记录一起删掉。
    //
    // 幂等：删第二遍时各表都查不到这个人，计数全 0，仍然返回成功。
    async deleteUser(uid) {
      const id = String(uid || "").trim();
      const deleted = { users: 0, saves: 0, focus_records: 0, tracking_events: 0, grants: 0, feedback: 0 };
      if (!id) return { userId: "", deleted };

      if (users.delete(id)) deleted.users++;
      if (saves.delete(id)) deleted.saves++;

      // focusRecords / grants / feedback 都是「按行 id 索引」的 Map，只能逐条比对 user_id。
      for (const [key, row] of [...focusRecords]) {
        if (row && row.user_id === id) { focusRecords.delete(key); deleted.focus_records++; }
      }
      for (const [key, row] of [...grants]) {
        if (row && row.user_id === id) { grants.delete(key); deleted.grants++; }
      }
      for (const [key, row] of [...feedback]) {
        if (row && row.user_id === id) { feedback.delete(key); deleted.feedback++; }
      }

      // trackingEvents 是数组，且可能有别的闭包持有同一引用 → 原地过滤，别重新赋值。
      let removed = 0;
      const kept = [];
      for (const row of trackingEvents) {
        if (row && row.user_id === id) removed++;
        else kept.push(row);
      }
      if (removed) {
        trackingEvents.length = 0;
        trackingEvents.push(...kept);
      }
      deleted.tracking_events = removed;

      return { userId: id, deleted };
    },

    // 仅供测试观察
    _sizes: () => ({ users: users.size, saves: saves.size, focusRecords: focusRecords.size, grants: grants.size, trackingEvents: trackingEvents.length, feedback: feedback.size })
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

    // readiness 探针用：真的打一次数据库，但只取一行的一个字段（不扫表、不写）。
    // 「进程活着」和「数据库连得上」是两件事 —— /api/health 只回答前者，
    // 这个 ping 才是判断「现在能不能接客」的依据。
    async ping() {
      await db.from(TABLE_SAVES).select("user_id").limit(1).throwOnError();
      return { ok: true, driver: "cloudbase" };
    },

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

    // 写存档。
    // expectUpdatedAt：乐观锁。传了「读到的 updated_at」后，更新会额外带上这个条件，
    // 条件不满足（别人先写过了）就返回 { conflict: true } 而不是覆盖 —— 这一点很关键，
    // 因为「读-算-写」跨了多次网络往返，中间任何一次别人写入都会被这次覆盖掉（丢更新）。
    // 不传则保持原语义（无条件写），供确实不需要并发保护的场景使用。
    async putSave(uid, data, { saveVersion = "", clientTs = 0, at = now(), expectUpdatedAt = null } = {}) {
      const existing = await selectOne(TABLE_SAVES, "user_id", uid);
      const row = {
        user_id: uid,
        data: JSON.stringify(data),
        save_version: saveVersion,
        client_ts: clientTs,
        updated_at: at
      };
      if (existing) {
        // ⚠️ 这里特意**不做**「先读-再比-再写」的应用层校验：那样两次往返之间还有窗口。
        //    把旧值直接写在 WHERE 条件里，让数据库自己保证「读到的还没被改过」。
        let query = db.from(TABLE_SAVES).update(row).eq("user_id", uid);
        if (expectUpdatedAt !== null) query = query.eq("updated_at", expectUpdatedAt);
        await query.throwOnError();
        // 条件不满足时 update 不报错、只是影响 0 行，所以必须回读一次确认到底写没写。
        if (expectUpdatedAt !== null) {
          const after = await selectOne(TABLE_SAVES, "user_id", uid);
          const currentVersion = after ? Number(after.updated_at) || 0 : 0;
          // 我写成功的判据是「版本号已经变成我这次要写的值」。
          if (currentVersion !== Number(at)) return { conflict: true, currentUpdatedAt: currentVersion };
        }
      } else {
        try {
          await db.from(TABLE_SAVES).insert([row], { defaultToNull: false }).throwOnError();
        } catch (error) {
          const again = await selectOne(TABLE_SAVES, "user_id", uid);
          // 插入撞主键 = 别人抢先建了这行 → 交给冲突重试逻辑，别在这里覆盖。
          if (!again) throw error;
          if (expectUpdatedAt !== null) return { conflict: true, currentUpdatedAt: Number(again.updated_at) || 0 };
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
      // ⚠️ 判据是 `> 0`（**真正结算过**），不是「非 0」—— claimFocusSession 写进去的是
      //    **负数**哨兵，必须放它过去，把 counted_minutes / reward / natural 补上。
      //    防重放由 claimFocusSession 的 CAS 负责；这里再拦一道只会把补写拦掉（2026-10-06 的线上 bug）。
      if (Number(row.settled_at) > 0) return { ...row, alreadySettled: true };
      await db.from(TABLE_FOCUS_RECORDS).update({
        counted_minutes: countedMinutes,
        reward,
        natural: natural ? 1 : 0,
        settled_at: settledAt
      }).eq("id", id).throwOnError();
      return { ...row, counted_minutes: countedMinutes, reward, natural, settled_at: settledAt, alreadySettled: false };
    },

    // ===== 专注会话持久层（跨实例 / 跨重启结算用）=====
    // 会话本来就落在 focus_records 里（start 时写的未结算行），所以这里不需要新表。
    async findFocusSession(id) {
      return selectOne(TABLE_FOCUS_RECORDS, "id", id);
    },

    // 🔴 抢占会话：把 settled_at 从 0 改成**负数哨兵**，条件写在 WHERE 里。
    //    云开发 RDB 的 update 不回传影响行数（实测拿不到 count），所以抢完必须回读确认 ——
    //    「update 不报错」和「真的改到了」是两件事。
    //    返回 false = 这行不存在，或已经被别的实例/请求抢走了（防重放的关键一步）。
    //
    // 🔴🔴 哨兵**必须是负数**（线上 bug，2026-10-06）：settleFocusRecord 用 `settled_at > 0`
    //    判「已经真正结算过」，看到正数就提前返回。以前这里用 now()（正数）当哨兵 →
    //    刚抢到的哨兵被紧随其后的补写误判成「重复结算」→ counted_minutes / reward / natural
    //    **永远写不进去** → 玩家看到「专注次数 +1、累计时长 +0」。
    //    内存版用的是 -1，一直是对的 —— 这就是两个 store 的实现漂移。
    //    取 `-now()` 而不是固定 -1：并发两次认领时，回读要能区分「是不是我写的」。
    async claimFocusSession(id) {
      const row = await selectOne(TABLE_FOCUS_RECORDS, "id", id);
      if (!row) return false;
      if (Number(row.settled_at) > 0) return false;
      const claimedAt = -now();
      await db.from(TABLE_FOCUS_RECORDS).update({ settled_at: claimedAt })
        .eq("id", id).eq("settled_at", 0).throwOnError();
      const after = await selectOne(TABLE_FOCUS_RECORDS, "id", id);
      // 成功判据是「我写进去的那个值现在就在库里」—— 被抢走的话它是别人的值。
      return Boolean(after && Number(after.settled_at) === claimedAt);
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

    // ===== 玩家反馈（设置里的「联系我们」）=====
    // 与内存实现同一套语义，不重复注释理由。
    // 排序同样在 JS 侧做（理由见 listGrants：order 的实际行为没在线上验证过）。
    async addFeedback({ id, userId = "", nickname = "", contact = "", message = "", at = now() } = {}) {
      const row = {
        id: id,
        user_id: String(userId || ""),
        nickname: String(nickname || ""),
        contact: String(contact || ""),
        message: String(message || ""),
        status: "new",
        created_at: at,
        handled_at: 0
      };
      await db.from(TABLE_FEEDBACK).insert([row], { defaultToNull: false }).throwOnError();
      return { ...row };
    },

    async listFeedback({ status = "", limit = 200 } = {}) {
      let q = db.from(TABLE_FEEDBACK).select("*");
      if (status) q = q.eq("status", status);
      const { data } = await q.throwOnError();
      return (data || [])
        .slice()
        .sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))
        .slice(0, Math.max(0, limit));
    },

    // 🔴 这个 SDK 的 update 不回传影响行数，所以「行不存在」只能靠先查一次判断，
    //    写完再回读一次把真实落库值返回（后台据此刷新列表，不靠本地拼的对象）。
    async setFeedbackStatus(id, status, { at = now() } = {}) {
      const before = await selectOne(TABLE_FEEDBACK, "id", id);
      if (!before) return null;
      await db.from(TABLE_FEEDBACK).update({ status: status, handled_at: status === "new" ? 0 : at })
        .eq("id", id).throwOnError();
      return (await selectOne(TABLE_FEEDBACK, "id", id)) || null;
    },

    // 删除同样要回读确认 —— 与 deleteUser 同一个坑（delete 不报错 ≠ 真的删掉了）。
    async deleteFeedback(ids) {
      let removed = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        const before = await selectOne(TABLE_FEEDBACK, "id", id);
        if (!before) continue;
        await db.from(TABLE_FEEDBACK).delete().eq("id", id).throwOnError();
        const after = await selectOne(TABLE_FEEDBACK, "id", id);
        if (!after) removed++;
      }
      return removed;
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
    },

    // ===== 运营奖励（发放 / 认领 / 退回）=====
    // 一次 insert 写多行：后台是「选一批人发同一份奖励」，逐行 insert 会变成 N 次往返。
    async addGrants(rows) {
      const payload = rows.map(row => ({
        id: row.id,
        user_id: row.user_id,
        bubbles: Math.floor(Number(row.bubbles) || 0),
        items: typeof row.items === "string" ? row.items : serializeGrantItems(row.items),
        reason: String(row.reason || ""),
        created_at: row.created_at,
        claimed_at: 0
      }));
      if (!payload.length) return [];
      await db.from(TABLE_GRANTS).insert(payload, { defaultToNull: false }).throwOnError();
      return payload;
    },

    async listGrants({ userId = "", limit = 200 } = {}) {
      let q = db.from(TABLE_GRANTS).select("*");
      if (userId) q = q.eq("user_id", userId);
      const { data } = await q.throwOnError();
      // 排序与截断在 JS 侧做。构造器其实有 order 方法（fa-rdb-capability-probe.mjs 验过），
      // 但它的实际行为没在线上验证过，不值得为一次排序去赌 —— 这里的数据量本来就小。
      return (data || [])
        .slice()
        .sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))
        .slice(0, Math.max(0, limit));
    },

    // 按 reason 精确统计。三个条件都下推到查询里（eq + eq + gte）——
    // 这是**热路径**（每次事件触发都要问一次），不能像 listGrants 那样把该用户的
    // 全部历史行拉回来再过滤：专注奖励每天都会留一行，跑一年就是上千行。
    // 🔴 reason 必须精确匹配（`event:<id>`），不能用前缀 —— 否则 id 互为前缀的两个事件
    //    会互相污染配额（`event:e1` 与 `event:e10`）。
    async queryGrants({ userId = "", reason = "", since = 0 } = {}) {
      let q = db.from(TABLE_GRANTS).select("*");
      if (userId) q = q.eq("user_id", userId);
      if (reason) q = q.eq("reason", reason);
      if (since > 0) q = q.gte("created_at", since);
      const { data } = await q.throwOnError();
      const rows = Array.isArray(data) ? data : [];
      let lastAt = 0;
      for (const row of rows) {
        const at = Number(row.created_at) || 0;
        if (at > lastAt) lastAt = at;
      }
      return { count: rows.length, lastAt };
    },

    // 🔴 认领待领取的奖励：条件更新（claimed_at = 0 → 本次令牌）+ 回读确认。
    //
    //    为什么不能直接把 claimed_at 写成 now()：这个 SDK 不回传影响行数，
    //    「update 不报错」不等于「真的改到了」，只能靠回读比对确认自己抢到了。
    //    而如果两个请求在同一毫秒认领同一行、令牌都用 now()，两边回读到的是同一个值
    //    → 都以为自己抢到了 → 同一份奖励发两次。
    //    所以令牌用**负数随机值**：claimed_at 的正数区被毫秒时间戳占用、0 = 未领取，
    //    负数区空着，正好拿来当「每次认领唯一」的标记，回读比对才有意义。
    //    确认抢到后再把 claimed_at 改成真实时间（后台列表要显示领取时间）。
    async claimPendingGrants(uid, { at = now() } = {}) {
      const { data } = await db.from(TABLE_GRANTS).select("*")
        .eq("user_id", uid).eq("claimed_at", 0).throwOnError();
      const claimed = [];
      for (const row of (data || [])) {
        const token = -(1 + Math.floor(Math.random() * 2 ** 48));
        await db.from(TABLE_GRANTS).update({ claimed_at: token })
          .eq("id", row.id).eq("claimed_at", 0).throwOnError();
        const mine = await selectOne(TABLE_GRANTS, "id", row.id);
        if (!mine || Number(mine.claimed_at) !== token) continue; // 被别的请求抢走了
        await db.from(TABLE_GRANTS).update({ claimed_at: at })
          .eq("id", row.id).eq("claimed_at", token).throwOnError();
        const final = await selectOne(TABLE_GRANTS, "id", row.id);
        if (!final || Number(final.claimed_at) !== Number(at)) {
          // 极端情况（这一行被并发退回）：把令牌清回 0，别让奖励永久卡死。
          await db.from(TABLE_GRANTS).update({ claimed_at: 0 })
            .eq("id", row.id).eq("claimed_at", token).throwOnError();
          continue;
        }
        claimed.push(final);
      }
      return claimed;
    },

    // 补偿：退回「已认领但存档没写成」的行。必须回读确认 —— 退不掉的话奖励会卡住，
    // 调用方需要据此告警（见 server.js 的 releaseClaimed）。
    async releaseGrants(ids, { claimedAt } = {}) {
      let released = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        await db.from(TABLE_GRANTS).update({ claimed_at: 0 })
          .eq("id", id).eq("claimed_at", claimedAt).throwOnError();
        const after = await selectOne(TABLE_GRANTS, "id", id);
        if (after && Number(after.claimed_at) === 0) released++;
      }
      return released;
    },

    // ===== 自助注销：删掉这个人的全部数据 =====
    // 与内存实现同一套语义（硬删、6 张表、uid 非空、幂等），不重复注释理由。
    //
    // 🔴 这个 SDK 的 delete 不回传影响行数，「delete 不报错」不等于「真的删掉了」——
    //    和 claimPendingGrants 同一个坑。所以删完回读一次，报的是**实际清掉的行数**，
    //    而不是「发出了几次删除」。注销是低频操作，多打一次查询不值得优化。
    async deleteUser(uid) {
      const id = String(uid || "").trim();
      const deleted = { users: 0, saves: 0, focus_records: 0, tracking_events: 0, grants: 0, feedback: 0 };
      if (!id) return { userId: "", deleted };

      const tables = [
        ["users", TABLE_USERS],
        ["saves", TABLE_SAVES],
        ["focus_records", TABLE_FOCUS_RECORDS],
        ["tracking_events", TABLE_TRACKING_EVENTS],
        ["grants", TABLE_GRANTS],
        // 反馈里有玩家自己填的联系方式 —— 这一张尤其不能漏。
        ["feedback", TABLE_FEEDBACK]
      ];
      for (const [name, table] of tables) {
        const before = await db.from(table).select("*").eq("user_id", id).throwOnError();
        const beforeCount = Array.isArray(before && before.data) ? before.data.length : 0;
        if (!beforeCount) { deleted[name] = 0; continue; }
        await db.from(table).delete().eq("user_id", id).throwOnError();
        const after = await db.from(table).select("*").eq("user_id", id).throwOnError();
        const afterCount = Array.isArray(after && after.data) ? after.data.length : 0;
        deleted[name] = Math.max(0, beforeCount - afterCount);
      }
      return { userId: id, deleted };
    }
  };
}

export async function createPlayerStore() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbasePlayerStore(await getRdb());
  return createMemoryPlayerStore();
}
