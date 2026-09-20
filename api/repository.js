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
  }
};

function makeRecord(type, data, published = true) {
  return { type, id: type === "fish" ? data.fishid : type === "focus" ? "focus" : data.id, data, publishedData: published ? structuredClone(data) : null, published, updatedAt: now() };
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
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID });
  const collection = app.database().collection(process.env.CLOUDBASE_COLLECTION || "fishtank_configs");

  for (const [type, value] of Object.entries(seed)) {
    const values = Array.isArray(value) ? value : [value];
    for (const data of values) {
      const configId = type === "fish" ? data.fishid : type === "focus" ? "focus" : data.id;
      const existing = await collection.where({ type, configId }).limit(1).get();
      if (!existing.data.length) {
        await collection.add({ type, configId, data, publishedData: structuredClone(data), published: true, updatedAt: now() });
      }
    }
  }

  const toRecord = document => ({ type: document.type, id: document.configId, data: document.data, publishedData: document.publishedData || null, published: document.published === true, updatedAt: document.updatedAt });
  return {
    async list(type, publishedOnly = false) {
      let query = collection.where({ type });
      if (publishedOnly) query = query.where({ published: true });
      const result = await query.get();
      return result.data.map(toRecord);
    },
    async save(type, id, data) {
      const existing = await collection.where({ type, configId: id }).limit(1).get();
      const current = existing.data[0];
      const document = {
        type,
        configId: id,
        data,
        publishedData: current?.publishedData || (current?.published ? current.data : null),
        published: false,
        updatedAt: now()
      };
      if (current?._id) await collection.doc(current._id).set(document);
      else await collection.add(document);
      return toRecord({ ...document, configId: id });
    },
    async remove(type, id) {
      const result = await collection.where({ type, configId: id }).get();
      await Promise.all(result.data.map(document => collection.doc(document._id).remove()));
    },
    async publish(type, id) {
      const result = await collection.where({ type, configId: id }).limit(1).get();
      const document = result.data[0];
      if (!document) return null;
      const updatedAt = now();
      await collection.doc(document._id).update({ published: true, publishedData: document.data, updatedAt });
      return { type, id, data: document.data, publishedData: document.data, published: true, updatedAt };
    }
  };
}

export async function createRepository() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbaseRepository();
  if (process.env.NODE_ENV === "production") throw new Error("CLOUDBASE_ENV_ID is required in production");
  return createMemoryRepository();
}
