// T17 后台上传图片自动压缩（Tinify）回归测试。
//
// 盯的是三条命门：
//   ① 压缩失败**绝不阻断上传**（回落原图，quota/timeout/auth 都不抛异常）；
//   ② 按角色规格 resize（fish 只压不缩省配额），resize 失败退回未缩放结果；
//   ③ 响应体 data.image 恒存在（空壳也是存在）—— 后台提示只看 warning 非空。
//
// Tinify 的 HTTP 契约用 fetch 桩模拟（不引依赖、不打真网络）；
// 接口层（断言 11）另起真实 server —— 但不配 TINIFY_API_KEY，走「未配置」回落路径。
//
// 跑法：node test/image-compress.test.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1; else fail += 1;
}
function chkTrue(name, condition, detail = "") {
  const ok = condition === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : ` (${detail})`}`);
  if (ok) pass += 1; else fail += 1;
}

// 1x1 透明 PNG（IHDR colorType=6，RGBA），兼当「保透明」验证的素材。
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8f9ff1f0005fb02fe57c2b8a50000000049454e44ae426082",
  "hex"
);
const SMALLER = Buffer.from("tiny-png-bytes");   // 桩返回的「压缩结果」，比任何真实图都小

// ===== 模块加载：env 必须在 import 之前就位（tinify.js 在模块顶层读 env）=====
// ESM 对每个唯一 URL 各建一份模块实例 → 用 query 区分不同 env 配置。
const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = q => new URL(`../tinify.js${q}`, import.meta.url).href;

delete process.env.FISHTANK_TINIFY;
delete process.env.TINIFY_TIMEOUT_MS;
process.env.TINIFY_API_KEY = "unit-test-key";
const tinify = await import(modUrl(""));

delete process.env.TINIFY_API_KEY;
const tinifyNoKey = await import(modUrl("?case=nokey"));

process.env.TINIFY_API_KEY = "unit-test-key";
process.env.FISHTANK_TINIFY = "0";
const tinifyOff = await import(modUrl("?case=off"));

delete process.env.FISHTANK_TINIFY;
process.env.TINIFY_TIMEOUT_MS = "300";   // 实际下限 1000ms（模块里 Math.max(1000,…)）
const tinifySlow = await import(modUrl("?case=timeout"));
delete process.env.TINIFY_TIMEOUT_MS;

// ===== fetch 桩 =====
const LOCATION = "https://tinify.test/output/abc";
function stubFetch(resolver) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return resolver(String(url), options);
  };
  impl.calls = calls;
  return impl;
}
const shrinkOk = extra => new Response(null, { status: 201, headers: { location: LOCATION, "compression-count": "7" } });
const bytesOk = buf => new Response(new Uint8Array(buf), { status: 200, headers: { "compression-count": "8" } });
const errorOf = (status, message) => new Response(JSON.stringify({ error: "TinyPNG", message }), { status });

const realFetch = globalThis.fetch;
const useFetch = impl => { globalThis.fetch = impl; };

// ===== 1/2. 未配置：不调 Tinify，原样回落 =====
{
  const f = stubFetch(() => { throw new Error("不该发请求"); });
  useFetch(f);
  const r = await tinifyNoKey.compressImage(PNG, { mimeType: "image/png" });
  chk("未配 key → skipped", r.skipped, "not-configured");
  chk("未配 key → 不压缩、buffer 原样", [r.compressed, r.buffer.equals(PNG), r.size === r.originalSize], [false, true, true]);
  chk("未配 key → warning 为空（后台不出红字）", r.warning, "");
  chk("未配 key → 不发任何请求", f.calls.length, 0);
}
{
  const f = stubFetch(() => { throw new Error("不该发请求"); });
  useFetch(f);
  const r = await tinifyOff.compressImage(PNG, { mimeType: "image/png" });
  chk("FISHTANK_TINIFY=0 → 总开关生效", r.skipped, "not-configured");
}

// ===== 3. 正常压缩 + 缩放 =====
{
  let resizeBody = null;
  const f = stubFetch((url, options) => {
    if (url === "https://api.tinify.com/shrink") return shrinkOk();
    if (url === LOCATION && options.method === "POST") { resizeBody = String(options.body); return bytesOk(SMALLER); }
    if (url === LOCATION && options.method === "GET") return bytesOk(SMALLER);
    return errorOf(500, "unexpected");
  });
  useFetch(f);
  const big = Buffer.concat([PNG, Buffer.alloc(60000, 1)]);
  const r = await tinify.compressImage(big, { mimeType: "image/png", role: "background" });
  chk("压缩成功 → compressed + 变小 + 新字节", [r.compressed, r.size < r.originalSize, r.buffer.equals(SMALLER)], [true, true, true]);
  chk("resize 按规格（background → 1600×900 fit）", JSON.parse(resizeBody || "{}"), { resize: { method: "fit", width: 1600, height: 900 } });
  chk("compressionCount 取自响应头", r.compressionCount, 8);
  chk("Authorization 是 Basic api:<key>", f.calls[0].options.headers.Authorization, "Basic " + Buffer.from("api:unit-test-key").toString("base64"));
  chk("shrink 请求体是原图字节", Buffer.from(f.calls[0].options.body).equals(big), true);
}

// ===== 4. 压缩后仍超上限：overLimit + warning，但不阻断 =====
{
  const oversized = Buffer.alloc(500 * 1024, 2);
  const f = stubFetch(url => (url.endsWith("/shrink") ? shrinkOk() : bytesOk(oversized)));
  useFetch(f);
  const r = await tinify.compressImage(PNG, { mimeType: "image/png", role: "resource" });
  chk("超上限 → overLimit + warning 非空", [r.overLimit, r.warning.length > 0], [true, true]);
  chk("超上限 → buffer 仍是压缩结果（照常上传）", r.buffer.equals(oversized), true);
}

// ===== 5. 429 配额用完：回落原图，不抛异常 =====
{
  const f = stubFetch(() => errorOf(429, "Monthly quota exceeded"));
  useFetch(f);
  const r = await tinify.compressImage(PNG, { mimeType: "image/png" });
  chk("429 → skipped=quota + 原图回落", [r.skipped, r.buffer.equals(PNG), r.size === r.originalSize], ["quota", true, true]);
  chk("429 → warning 提示次数用完", /次数已用完/.test(r.warning), true);
}

// ===== 6. 超时：回落原图 =====
{
  const f = stubFetch((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  }));
  useFetch(f);
  const r = await tinifySlow.compressImage(PNG, { mimeType: "image/png" });
  chk("超时 → skipped=timeout + 原图回落", [r.skipped, r.buffer.equals(PNG)], ["timeout", true]);
}

// ===== 7. 不支持的类型：svg 不进 Tinify =====
{
  const f = stubFetch(() => { throw new Error("不该发请求"); });
  useFetch(f);
  const r = await tinify.compressImage(Buffer.from("<svg/>"), { mimeType: "image/svg+xml" });
  chk("svg → unsupported-type 且不发请求", [r.skipped, f.calls.length], ["unsupported-type", 0]);
}

// ===== 8/9. 角色决定要不要 resize =====
{
  const f = stubFetch((url, options) => (url.endsWith("/shrink") ? shrinkOk() : bytesOk(SMALLER)));
  useFetch(f);
  await tinify.compressImage(PNG, { mimeType: "image/png", role: "fish" });
  chk("fish → 只 shrink + GET，不发 resize", f.calls.map(c => `${c.options.method || "GET"} ${c.url}`),
    [`POST https://api.tinify.com/shrink`, `GET ${LOCATION}`]);

  const f2 = stubFetch((url, options) => (url.endsWith("/shrink") ? shrinkOk() : bytesOk(SMALLER)));
  useFetch(f2);
  await tinify.compressImage(PNG, { mimeType: "image/png", role: "background" });
  chk("background → shrink + POST resize + 共 2 次上游调用", f2.calls.length, 2);
}

// ===== 10. specFor 未知角色兜底 =====
chk("specFor(未知角色) → resource", tinify.specFor("不存在的角色"), tinify.IMAGE_SPECS.resource);
chk("specFor(空) → resource", tinify.specFor(""), tinify.IMAGE_SPECS.resource);

// ===== 12. 透明通道不被压掉（PNG IHDR colorType 仍是 6）=====
{
  const f = stubFetch(url => (url.endsWith("/shrink") ? shrinkOk() : bytesOk(PNG)));
  useFetch(f);
  const r = await tinify.compressImage(PNG, { mimeType: "image/png", role: "sand" });
  chk("透明 PNG 走完压缩 colorType 仍=6（alpha 保住）", r.buffer[25], 6);
}

useFetch(realFetch);

// ===== 11. 接口层：data.image 恒存在（不配 key 的空壳也要有）=====
const apiDir = path.join(here, "..");
const PORT = 8097;
const KEY = "test-key-1234567890";
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-tinify-"));
const childEnv = { ...process.env, NODE_ENV: "test", PORT: String(PORT), EXTRA_PORTS: "0", ADMIN_API_KEY: KEY, UPLOAD_DIR };
delete childEnv.TINIFY_API_KEY;        // 接口层走「未配置」路径，验证 data.image 空壳恒存在
delete childEnv.FISHTANK_TINIFY;
delete childEnv.TINIFY_TIMEOUT_MS;
const child = spawn(process.execPath, ["server.js"], { env: childEnv, cwd: apiDir, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => (log += d));
child.stderr.on("data", d => (log += d));

function multipart(fields) {
  const boundary = "----focusaquarium" + Date.now();
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"${f.fileName ? `; filename="${f.fileName}"` : ""}\r\nContent-Type: ${f.contentType || "text/plain"}\r\n\r\n`));
    parts.push(typeof f.value === "string" ? Buffer.from(f.value) : f.value);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) } };
}
function post(pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST", headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function waitForPort(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET" }, res => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject);
        req.end();
      });
      return true;
    } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  return false;
}

const up = await waitForPort();
if (!up) {
  console.log("FAIL | 服务未在预期时间内启动");
  console.log(log);
  child.kill();
  process.exit(1);
}

{
  const form = multipart([
    { name: "file", value: new Uint8Array(PNG), fileName: "fish.png", contentType: "image/png" },
    { name: "role", value: "fish" }
  ]);
  const res = await post("/api/admin/assets/image", form.body, { ...form.headers, "x-admin-key": KEY });
  chk("接口层：上传 → 200", res.status, 200);
  const data = (JSON.parse(res.body) || {}).data || {};
  chk("接口层：path 落盘 images/ 下", String(data.path || "").startsWith("images/"), true);
  chkTrue("接口层：data.image 恒存在（未配置也是对象）", Boolean(data.image && typeof data.image === "object"), JSON.stringify(data.image || null));
  chk("接口层：data.size === data.image.size", [data.size, data.image && data.image.size], [PNG.length, PNG.length]);
  chk("接口层：未配置 → compressed=false / skipped=not-configured / warning 空",
    [data.image.compressed, data.image.skipped, data.image.warning], [false, "not-configured", ""]);
  chk("接口层：originalSize 回显原始字节数", data.image.originalSize, PNG.length);
}

child.kill();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
console.log("----");
console.log(`image-compress.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
