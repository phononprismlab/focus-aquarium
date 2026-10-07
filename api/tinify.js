// 后台上传图片自动压缩（Tinify / TinyPNG）。
// 设计要点：
//   ① 不引依赖 —— Node 有全局 fetch，和 uploads.js 调 PG 网关是同一套写法。
//   ② 压缩 + 按角色规格缩放（2 次配额）；`width:0` 的角色（fish）只压不缩（1 次）。
//   ③ 绝不 convert —— PNG→PNG 才能保住透明通道（沙/装饰/鱼都是透明底）。
//   ④ 任何失败都**不阻断上传** —— 回落到原图，把原因回报给后台做提示。

const API_KEY = String(process.env.TINIFY_API_KEY || "").trim();
export const TINIFY_ENABLED = Boolean(API_KEY) && process.env.FISHTANK_TINIFY !== "0";
const TIMEOUT_MS = Math.max(1000, Number(process.env.TINIFY_TIMEOUT_MS || 15000));
const SHRINK_URL = "https://api.tinify.com/shrink";
// Tinify 单次上传的体积上限官方未写明（历史文档为 5MB）。保守跳过，不阻断。
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const TINIFY_TYPES = /^image\/(png|jpeg|webp|avif)$/i;

// 角色 → 目标规格。width/height 为 0 = 只压不缩（保护「同画布同比例」的契约，见 fish）。
export const IMAGE_SPECS = {
  preview:    { width: 400,  height: 400, maxBytes: 100 * 1024 },
  background: { width: 1600, height: 900, maxBytes: 400 * 1024 },
  sand:       { width: 1600, height: 900, maxBytes: 400 * 1024 },
  decoration: { width: 1600, height: 900, maxBytes: 400 * 1024 },
  fish:       { width: 0,    height: 0,   maxBytes: 400 * 1024 },
  resource:   { width: 1600, height: 900, maxBytes: 400 * 1024 }
};

export function specFor(role) {
  return IMAGE_SPECS[String(role || "").trim()] || IMAGE_SPECS.resource;
}

function authHeader() {
  return "Basic " + Buffer.from(`api:${API_KEY}`).toString("base64");
}

async function tinifyFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Authorization: authHeader(), ...(options.headers || {}) }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function failureOf(response) {
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  const error = new Error((payload && payload.message) || `Tinify HTTP ${response.status}`);
  error.code = String(response.status);
  error.tinifyError = String((payload && payload.error) || "");
  return error;
}

/**
 * 压缩一张图。**永不抛异常** —— 任何失败都回落原图。
 * @returns {{buffer:Buffer, compressed:boolean, resized:object|null, skipped:string,
 *            compressionCount:number|null, originalSize:number, size:number,
 *            overLimit:boolean, limitBytes:number, warning:string}}
 */
export async function compressImage(buffer, { mimeType = "", role = "resource" } = {}) {
  const spec = specFor(role);
  const originalSize = buffer.length;
  const base = {
    buffer, compressed: false, resized: null, skipped: "",
    compressionCount: null, originalSize, size: originalSize,
    overLimit: originalSize > spec.maxBytes, limitBytes: spec.maxBytes, warning: ""
  };

  if (!TINIFY_ENABLED) return { ...base, skipped: "not-configured" };
  if (!TINIFY_TYPES.test(String(mimeType))) return { ...base, skipped: "unsupported-type" };
  if (originalSize > MAX_SOURCE_BYTES) return { ...base, skipped: "too-large-source" };

  try {
    // 1. 只压不缩
    const shrink = await tinifyFetch(SHRINK_URL, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: buffer
    });
    if (!shrink.ok) throw await failureOf(shrink);
    const location = shrink.headers.get("location");
    if (!location) throw Object.assign(new Error("Tinify 没有返回 Location"), { code: "NO_LOCATION" });
    let count = Number(shrink.headers.get("compression-count")) || null;

    // 2. 按角色规格缩放（`spec.width === 0` 的角色只取原压缩结果，不发 resize）
    let out;
    if (spec.width > 0) {
      out = await tinifyFetch(location, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resize: { method: "fit", width: spec.width, height: spec.height } })
      });
      // resize 失败（参数/配额）不算失败 —— 退回未缩放的压缩结果，仍然比原图小。
      if (!out.ok) out = await tinifyFetch(location, { method: "GET" });
      else count = Number(out.headers.get("compression-count")) || count;
    } else {
      out = await tinifyFetch(location, { method: "GET" });
    }
    if (!out.ok) throw await failureOf(out);

    const data = Buffer.from(await out.arrayBuffer());
    if (!data.length) throw Object.assign(new Error("Tinify 返回了空图"), { code: "EMPTY" });

    const overLimit = data.length > spec.maxBytes;
    return {
      buffer: data, compressed: true, resized: spec.width > 0 ? { width: spec.width, height: spec.height } : null,
      skipped: "", compressionCount: count, originalSize, size: data.length,
      overLimit, limitBytes: spec.maxBytes,
      warning: overLimit
        ? `素材过大：压缩后仍有 ${Math.round(data.length / 1024)}KB（上限 ${Math.round(spec.maxBytes / 1024)}KB），已照常上传`
        : ""
    };
  } catch (error) {
    const code = String(error.code || "");
    const skipped = error.name === "AbortError" ? "timeout"
      : code === "401" ? "auth"
      : code === "429" ? "quota"
      : "error";
    return {
      ...base, skipped,
      warning: skipped === "quota"
        ? "Tinify 本月压缩次数已用完，本次按原图上传"
        : skipped === "not-configured" ? ""
        : `自动压缩不可用（${error.message}），本次按原图上传`
    };
  }
}
