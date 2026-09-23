const now = () => new Date().toISOString();

const seed = {
  decorations: [
    { id: "fish001", category: "fish", name: "小丑鱼", description: "色彩明亮的小丑鱼，为鱼缸增添一点活泼的海洋气息。", previewImage: "", price: 30, resourcePath: "assets/fish/fish001.webp", isMemberOnly: false, maxInventory: 50, tags: [] },
    { id: "fish002", category: "fish", name: "蓝尾鱼", description: "带着蓝色尾鳍的小鱼，游动时看起来清爽又灵巧。", previewImage: "", price: 35, resourcePath: "assets/fish/fish002.webp", isMemberOnly: false, maxInventory: 50, tags: [] },
    { id: "fish003", category: "fish", name: "金色小鱼", description: "闪着金色光泽的小鱼，让鱼缸多一点温暖的亮色。", previewImage: "", price: 45, resourcePath: "assets/fish/fish003.webp", isMemberOnly: true, maxInventory: 50, tags: [] },
    // tags 上的 `undersea-treasure` 是「海底的宝藏」事件的挂钩（S2 / F15）：
    // 事件与资源之间只通过 tag 关联 —— 缸里有带这个 tag 的装扮，事件才可能触发。
    // ⚠️ 没有任何资源带它时，treasure 会**静默地永远不触发**（既不报错也不给泡泡）。
    // 换挂到别的装扮上不用改代码，后台改 tags 字段即可。
    { id: "decoration001", category: "decorations", name: "水草", description: "柔软舒展的基础水草，适合打造自然的鱼缸底景。", previewImage: "", price: 20, resourcePath: "assets/plants/plant001.webp", isMemberOnly: false, maxInventory: 1, tags: ["undersea-treasure"] },
    { id: "decoration002", category: "decorations", name: "细叶水草", description: "细长挺拔的水草，让鱼缸拥有更丰富的层次。", previewImage: "", price: 30, resourcePath: "assets/plants/plant002.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "decoration003", category: "decorations", name: "红色水草", description: "带有红色叶片的水草，为鱼缸加入一抹醒目的颜色。", previewImage: "", price: 50, resourcePath: "assets/plants/plant003.webp", isMemberOnly: true, maxInventory: 1, tags: [] },
    { id: "background001", category: "backgrounds", name: "浅海晨光", description: "明亮柔和的浅海背景。", previewImage: "", price: 30, resourcePath: "assets/backgrounds/background001.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "background002", category: "backgrounds", name: "深海夜色", description: "深沉安静的海底夜色。", previewImage: "", price: 60, resourcePath: "assets/backgrounds/background002.webp", isMemberOnly: true, maxInventory: 1, tags: [] },
    { id: "background003", category: "backgrounds", name: "珊瑚黄昏", description: "带着珊瑚色调的黄昏海景。", previewImage: "", price: 50, resourcePath: "assets/background003.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sand001", category: "sands", name: "暖色细沙", description: "温暖细腻的浅色沙地。", previewImage: "", price: 20, resourcePath: "assets/sands/sand001.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sand002", category: "sands", name: "深海黑沙", description: "沉静的深色沙地。", previewImage: "", price: 35, resourcePath: "assets/sands/sand002.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sound001", category: "sounds", name: "海水白噪音", description: "轻柔的水下环境声。", previewImage: "", price: 25, resourcePath: "assets/sounds/sound001.mp3", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sound002", category: "sounds", name: "轻柔气泡声", description: "细碎轻盈的气泡声。", previewImage: "", price: 40, resourcePath: "assets/sounds/sound002.mp3", isMemberOnly: true, maxInventory: 1, tags: [] }
  ],
  fish: [
    { fishid: "fish001", name: "小丑鱼", resourcePath: "assets/fish/clownfish.png", movementCode: "gentle-swim", scaleMin: 0.8, scaleMax: 1.1, feedReaction: true, tags: [] },
    { fishid: "fish002", name: "蓝尾鱼", resourcePath: "assets/fish/blue-tang.png", movementCode: "quick-swim", scaleMin: 0.7, scaleMax: 1.0, feedReaction: true, tags: [] }
  ],
  // 随机事件（F6）：**全部走配置，不写代码**（用户 2026-09-23 决定）。
  // 事件与资源之间只通过 relatedTag / conditions.hasTag 关联，新增资源只要打上 tag 就能被事件用上，
  // 不需要改事件本身，也不需要改前端（F15）。
  //
  // 字段说明：
  //   eventType            online=在线检测 / offline=再次进入时按离线时长结算（F11）
  //   handler              内置 handler 名，见 index.html 的 EVENT_HANDLERS（F12）
  //   params               handler 参数（数量区间、存活时长…）
  //   relatedTag           关联的资源 tag（S2）——文案里的 {source} 就是命中的资源名
  //   probability          单次检测命中率（S8：不是「每分钟」也不是「每次专注」）
  //   checkIntervalSeconds 在线检测间隔（S8）
  //   cooldownMinutes      同一事件冷却（S8）
  //   maxPerDay            每日上限（S8）
  //   message              叙事文案，支持 {count} {name} {source} 占位符
  //   conditions           触发前置条件（F8，结构化规则，不是代码）
  events: [
    {
      id: "give-bubbles",
      name: "意外的礼物",
      description: "小鱼在缸里翻出了一小捧泡泡。",
      enabled: true,
      eventType: "online",
      handler: "give-bubbles",
      params: { min: 5, max: 15 },
      relatedTag: "",
      probability: 0.03,
      checkIntervalSeconds: 60,
      cooldownMinutes: 30,
      maxPerDay: 3,
      message: "小鱼在缸里翻出了一小捧泡泡，{count} 颗泡泡落进了你的口袋。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "" }
    },
    {
      id: "treasure",
      name: "海底的宝藏",
      description: "小鱼在带 undersea-treasure 标签的装扮里发现了泡泡。",
      enabled: true,
      eventType: "online",
      handler: "treasure",
      params: { min: 15, max: 40 },
      relatedTag: "undersea-treasure",
      probability: 0.02,
      checkIntervalSeconds: 120,
      cooldownMinutes: 120,
      maxPerDay: 2,
      message: "小鱼钻进{source}里，叼出了 {count} 颗泡泡。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "undersea-treasure" }
    },
    {
      id: "fish-escape",
      name: "小鱼跳出了鱼缸",
      description: "某条鱼顺着水流跳出了鱼缸。想它的话，可以再去商店接一条回来。",
      enabled: true,
      eventType: "online",
      handler: "fish-escape",
      // 经济循环的消耗端（S6）：鱼会真的走，但可回购。
      // minSurvivalMinutes：刚买不久的鱼不参与，避免「刚买就跳」的挫败感。
      params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 },
      relatedTag: "",
      probability: 0.01,
      checkIntervalSeconds: 300,
      cooldownMinutes: 720,
      maxPerDay: 1,
      message: "{name} 顺着水流跳出了鱼缸。想它的话，可以再去商店接一条回来。",
      // minFish 至少 2：不让最后一条鱼也走掉，避免留下一个空缸。
      conditions: { minFish: 2, minBubbles: 0, hasTag: "" }
    },
    {
      id: "welcome-back",
      name: "久别重逢",
      description: "离开一段时间后回来，小鱼攒了一点泡泡。",
      enabled: true,
      // offline：不是定时检测，而是**再次进入时**按离线时长结算（F11）。
      eventType: "offline",
      handler: "give-bubbles",
      // maxOfflineHours：单次离线时长上限，防挂机刷（S7）。挂一天和挂一周结果一样。
      params: { min: 8, max: 24, maxOfflineHours: 24 },
      relatedTag: "",
      // probability 在这里是「**每小时**离线的命中率」：离线越久越可能触发，封顶 1。
      probability: 0.3,
      // 离线事件不使用检测间隔，这一项只为了满足配置形状（服务端对 offline 不强制校验）。
      checkIntervalSeconds: 60,
      cooldownMinutes: 480,
      maxPerDay: 1,
      message: "好久没来了。小鱼攒了 {count} 颗泡泡，都给你。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "" }
    }
  ],
  focus: {
    minFocusDuration: 25,
    maxFocusDuration: 120,
    rewardTiers: [
      { id: "tier-1", endMinute: 25, normalBubblePerMinute: 1, memberBubblePerMinute: 2 },
      { id: "tier-2", endMinute: 60, normalBubblePerMinute: 2, memberBubblePerMinute: 3 },
      { id: "tier-3", endMinute: 120, normalBubblePerMinute: 3, memberBubblePerMinute: 5 }
    ]
  },
  audio: {
    categories: {
      bgm: { label: "背景白噪音", enabled: true, volume: 38 },
      prompt: { label: "提示音", enabled: true, volume: 100 },
      sfx: { label: "交互音效", enabled: true, volume: 100 }
    },
    sounds: [
      { id: "water-ambient", name: "海水白噪音", category: "bgm", enabled: true, volume: 100, resourcePath: "assets/sounds/water-ambient.mp3", loop: true },
      { id: "focus-start", name: "开始专注", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "focus-complete", name: "专注完成", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "feed", name: "投喂饲料", category: "sfx", enabled: true, volume: 100, resourcePath: "" },
      { id: "fish-startle", name: "鱼儿受惊", category: "sfx", enabled: true, volume: 100, resourcePath: "" }
    ]
  }
};

const singletonTypes = new Set(["focus", "audio"]);
const idForType = (type, data) => type === "fish" ? data.fishid : singletonTypes.has(type) ? type : data.id;

function makeRecord(type, data, published = true) {
  return { type, id: idForType(type, data), data, publishedData: published ? structuredClone(data) : null, published, updatedAt: now() };
}

// ===== 种子数据迁移（B2）=====
// 旧逻辑只在行不存在时 insert，已存在的行永不更新 —— 导致「新增默认项 / 改默认参数 / 加新字段」
// 无法下发到已部署环境（老用户永远看到旧默认集）。
// 现在改为：启动时按 seed 合并，保证默认集持续一致，且**绝不覆盖用户已改过的内容**。

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// B15：种子历史上写过一批**并不存在**的 previewImage 假路径（assets/xxx/yyy_preview.webp）。
// 这些文件从未上传过，留在配置里只会在商店里各打一次 404。老库若还是这些值，视为「未设置」清掉，
// 让 seed 的空值生效。后台上传的图落在 images/ 且文件名带时间戳+uuid，不会命中这个形状。
const LEGACY_PLACEHOLDER_PREVIEW = /^assets\/[\w-]+\/[\w-]+_preview\.(webp|png|jpe?g|gif|avif)$/i;
export function isLegacyPlaceholderPreview(value) {
  return typeof value === "string" && LEGACY_PLACEHOLDER_PREVIEW.test(value.trim());
}

// 把 seed 默认值应用到某条已存储记录，返回「应当写入的数据」。
// - 单例配置（focus / audio）：直接以最新 seed 为准（应用配置更新应随版本生效）。
// - 用户内容（decorations / fish）：以 seed 为基底，仅补齐缺失字段，保留用户已有值。
export function applySeedDefault(type, stored, seed) {
  const base = structuredClone(seed);
  if (singletonTypes.has(type)) return base;
  const merged = base;
  for (const [k, v] of Object.entries(stored || {})) {
    if (v === null || v === undefined) continue;
    // B15：老库里的假预览图路径不算「用户填过的值」，丢掉让 seed 的空值生效。
    if (k === "previewImage" && isLegacyPlaceholderPreview(v)) continue;
    merged[k] = v;
  }
  return merged;
}

// 纯函数：规划某 type 的 seed 迁移操作（不触碰数据库），供云端仓库复用与单测。
// existingRows 形状：{ id, data, publishedData, rowId }
export function planSeedMigration(type, seedValues, existingRows) {
  const existingById = new Map(existingRows.map(r => [r.id, r]));
  return seedValues.map(seed => {
    const id = idForType(type, seed);
    const existing = existingById.get(id);
    if (!existing) {
      return { action: "insert", id, data: structuredClone(seed) };
    }
    const newData = applySeedDefault(type, existing.data, seed);
    const newPublished = existing.publishedData != null
      ? applySeedDefault(type, existing.publishedData, seed)
      : newData;
    const changed = !deepEqual(newData, existing.data) || !deepEqual(newPublished, existing.publishedData);
    if (!changed) return { action: "skip", id };
    return { action: "update", id, data: newData, publishedData: newPublished, rowId: existing.rowId };
  });
}

export function createMemoryRepository() {
  const records = new Map();
  Object.entries(seed).forEach(([type, value]) => {
    const values = Array.isArray(value) ? value : [value];
    values.forEach(data => {
      const record = makeRecord(type, structuredClone(data));
      records.set(`${type}:${record.id}`, record);
    });
  });

  return {
    async list(type, publishedOnly = false) {
      return [...records.values()].filter(record => record.type === type && (!publishedOnly || record.published)).map(record => structuredClone(record));
    },
    async save(type, id, data) {
      const key = `${type}:${id}`;
      const current = records.get(key);
      const record = current ? {
        ...current,
        data: structuredClone(data),
        published: false,
        updatedAt: now()
      } : makeRecord(type, structuredClone(data), false);
      records.set(key, record);
      return structuredClone(record);
    },
    async remove(type, id) {
      records.delete(`${type}:${id}`);
    },
    async publish(type, id) {
      const record = records.get(`${type}:${id}`);
      if (!record) return null;
      record.published = true;
      record.publishedData = structuredClone(record.data);
      record.updatedAt = now();
      return structuredClone(record);
    }
  };
}

export async function createCloudbaseRepository() {
  const { default: cloudbase } = await import("@cloudbase/js-sdk");
  const app = cloudbase.init({
    env: process.env.CLOUDBASE_ENV_ID,
    accessKey: process.env.CLOUDBASE_APIKEY
  });
  const db = app.rdb();
  const tableName = "fishtank_configs";

  // 种子迁移：把 seed 的默认集合并进已部署的数据库（B2）。
  // 一次性按 type 拉取全部已存在行，与 seed 比对后规划 insert / update / skip，
  // 缺失的新项与缺失字段会被补齐，用户已改过的内容不会被覆盖。
  for (const [type, value] of Object.entries(seed)) {
    const seedValues = Array.isArray(value) ? value : [value];
    const { data: rows } = await db.from(tableName).select("*").eq("type", type).throwOnError();
    // 防御：数据层异常时 select 可能返回非数组（测试用的假环境就会这样），
    // 归一化成数组，避免 .map 直接把整个仓库初始化搞崩。真实环境正常返回数组。
    const existingRows = Array.isArray(rows) ? rows : [];
    const plan = planSeedMigration(type, seedValues, existingRows.map(r => ({
      id: r.config_id,
      data: r.data || {},
      publishedData: r.published_data,
      rowId: r.id
    })));
    for (const op of plan) {
      if (op.action === "insert") {
        await db.from(tableName).insert([{
          type,
          config_id: op.id,
          data: op.data,
          published_data: structuredClone(op.data),
          published: true,
          updated_at: now()
        }], { defaultToNull: false }).throwOnError();
      } else if (op.action === "update") {
        await db.from(tableName).update({
          data: op.data,
          published_data: op.publishedData ?? op.data,
          updated_at: now()
        }).eq("id", op.rowId).throwOnError();
      }
    }
  }

  const toRecord = row => ({
    type: row.type,
    id: row.config_id,
    data: row.data,
    publishedData: row.published_data || null,
    published: row.published === true,
    updatedAt: row.updated_at
  });
  return {
    async list(type, publishedOnly = false) {
      let query = db.from(tableName).select("*").eq("type", type);
      if (publishedOnly) query = query.eq("published", true);
      const { data } = await query.throwOnError();
      return data.map(toRecord);
    },
    async save(type, id, data) {
      const { data: existing } = await db
        .from(tableName)
        .select("*")
        .eq("type", type)
        .eq("config_id", id)
        .limit(1)
        .throwOnError();
      const current = existing[0];
      const row = {
        type,
        config_id: id,
        data,
        published_data: current?.published_data || (current?.published ? current.data : null),
        published: false,
        updated_at: now()
      };
      if (current) {
        await db.from(tableName).update(row).eq("id", current.id).throwOnError();
      } else {
        await db.from(tableName).insert([row], { defaultToNull: false }).throwOnError();
      }
      return toRecord({ ...row, id: current?.id });
    },
    async remove(type, id) {
      const { data: existing } = await db
        .from(tableName)
        .select("id")
        .eq("type", type)
        .eq("config_id", id)
        .throwOnError();
      await Promise.all(existing.map(row => db.from(tableName).delete().eq("id", row.id).throwOnError()));
    },
    async publish(type, id) {
      const { data: existing } = await db
        .from(tableName)
        .select("*")
        .eq("type", type)
        .eq("config_id", id)
        .limit(1)
        .throwOnError();
      const current = existing[0];
      if (!current) return null;
      const updatedAt = now();
      await db.from(tableName).update({
        published: true,
        published_data: current.data,
        updated_at: updatedAt
      }).eq("id", current.id).throwOnError();
      return { type, id, data: current.data, publishedData: current.data, published: true, updatedAt };
    }
  };
}

export async function createRepository() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbaseRepository();
  if (process.env.NODE_ENV === "production") throw new Error("CLOUDBASE_ENV_ID is required in production");
  return createMemoryRepository();
}
