// 音频配置的校验规则。抽成独立模块，服务端与测试共用同一份判断。
// 分类不再固定为 bgm/prompt/sfx：以后台实际定义的 categories 为准，
// 但 key 会被当作 localStorage 后缀和 DOM 属性使用，所以限制字符集。

export const AUDIO_CATEGORY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function validateAudioConfig(data) {
  if (!data.categories || typeof data.categories !== "object" || Array.isArray(data.categories)) {
    return "音频配置必须包含 categories";
  }
  if (!Array.isArray(data.sounds)) return "音频配置必须包含 sounds 数组";

  const categoryKeys = Object.keys(data.categories);
  if (!categoryKeys.length) return "至少需要保留一个音效分类";

  for (const key of categoryKeys) {
    if (!AUDIO_CATEGORY_KEY_PATTERN.test(key)) {
      return `分类 key 只能是字母、数字、下划线或连字符（1-32 位）：${key}`;
    }
    const label = data.categories[key]?.label;
    if (typeof label !== "string" || !label.trim()) return `分类 ${key} 必须填写名称`;
    const volume = Number(data.categories[key]?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return `分类 ${key} 的音量必须在 0-100 之间`;
    }
  }

  for (const sound of data.sounds) {
    if (!sound || typeof sound !== "object") return "音效必须是对象";
    if (!sound.id || !sound.name || !sound.category) return "每个音效必须包含 id、name、category";
    if (!categoryKeys.includes(sound.category)) return `音效分类无效：${sound.category}（不在已定义的分类中）`;
    const volume = Number(sound.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) return `音效 ${sound.id} 的音量必须在 0-100 之间`;
  }

  return null;
}
