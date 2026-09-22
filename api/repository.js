const now = () => new Date().toISOString();

const seed = {
  decorations: [
    { id: "fish001", category: "fish", name: "小丑鱼", description: "色彩明亮的小丑鱼，为鱼缸增添一点活泼的海洋气息。", previewImage: "assets/fish/fish001_preview.webp", price: 30, resourcePath: "assets/fish/fish001.webp", isMemberOnly: false, maxInventory: 50 },
    { id: "fish002", category: "fish", name: "蓝尾鱼", description: "带着蓝色尾鳍的小鱼，游动时看起来清爽又灵巧。", previewImage: "assets/fish/fish002_preview.webp", price: 35, resourcePath: "assets/fish/fish002.webp", isMemberOnly: false, maxInventory: 50 },
    { id: "fish003", category: "fish", name: "金色小鱼", description: "闪着金色光泽的小鱼，让鱼缸多一点温暖的亮色。", previewImage: "assets/fish/fish003_preview.webp", price: 45, resourcePath: "assets/fish/fish003.webp", isMemberOnly: true, maxInventory: 50 },
    { id: "decoration001", category: "decorations", name: "水草", description: "柔软舒展的基础水草，适合打造自然的鱼缸底景。", previewImage: "assets/plants/plant001_preview.webp", price: 20, resourcePath: "assets/plants/plant001.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "decoration002", category: "decorations", name: "细叶水草", description: "细长挺拔的水草，让鱼缸拥有更丰富的层次。", previewImage: "assets/plants/plant002_preview.webp", price: 30, resourcePath: "assets/plants/plant002.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "decoration003", category: "decorations", name: "红色水草", description: "带有红色叶片的水草，为鱼缸加入一抹醒目的颜色。", previewImage: "assets/plants/plant003_preview.webp", price: 50, resourcePath: "assets/plants/plant003.webp", isMemberOnly: true, maxInventory: 1 },
    { id: "background001", category: "backgrounds", name: "浅海晨光", description: "明亮柔和的浅海背景。", previewImage: "assets/backgrounds/background001_preview.webp", price: 30, resourcePath: "assets/backgrounds/background001.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "background002", category: "backgrounds", name: "深海夜色", description: "深沉安静的海底夜色。", previewImage: "assets/backgrounds/background002_preview.webp", price: 60, resourcePath: "assets/backgrounds/background002.webp", isMemberOnly: true, maxInventory: 1 },
    { id: "background003", category: "backgrounds", name: "珊瑚黄昏", description: "带着珊瑚色调的黄昏海景。", previewImage: "assets/backgrounds/background003_preview.webp", price: 50, resourcePath: "assets/background003.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "sand001", category: "sands", name: "暖色细沙", description: "温暖细腻的浅色沙地。", previewImage: "assets/sands/sand001_preview.webp", price: 20, resourcePath: "assets/sands/sand001.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "sand002", category: "sands", name: "深海黑沙", description: "沉静的深色沙地。", previewImage: "assets/sands/sand002_preview.webp", price: 35, resourcePath: "assets/sands/sand002.webp", isMemberOnly: false, maxInventory: 1 },
    { id: "sound001", category: "sounds", name: "海水白噪音", description: "轻柔的水下环境声。", previewImage: "assets/sounds/sound001_preview.webp", price: 25, resourcePath: "assets/sounds/sound001.mp3", isMemberOnly: false, maxInventory: 1 },
    { id: "sound002", category: "sounds", name: "轻柔气泡声", description: "细碎轻盈的气泡声。", previewImage: "assets/sounds/sound002_preview.webp", price: 40, resourcePath: "assets/sounds/sound002.mp3", isMemberOnly: true, maxInventory: 1 }
  ],
  fish: [
    { fishid: "fish001", name: "小丑鱼", resourcePath: "assets/fish/clownfish.png", movementCode: "gentle-swim", scaleMin: 0.8, scaleMax: 1.1, feedReaction: true },
    { fishid: "fish002", name: "蓝尾鱼", resourcePath: "assets/fish/blue-tang.png", movementCode: "quick-swim", scaleMin: 0.7, scaleMax: 1.0, feedReaction: true }
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

  for (const [type, value] of Object.entries(seed)) {
    const values = Array.isArray(value) ? value : [value];
    for (const data of values) {
      const configId = idForType(type, data);
      const { data: existing } = await db
        .from(tableName)
        .select("id")
        .eq("type", type)
        .eq("config_id", configId)
        .limit(1)
        .throwOnError();
      if (!existing.length) {
        await db.from(tableName).insert([{
          type,
          config_id: configId,
          data,
          published_data: structuredClone(data),
          published: true,
          updated_at: now()
        }], { defaultToNull: false }).throwOnError();
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
