// PG 模式云存储通道的测试。
//
// 背景：本项目环境是 **PG 模式**（控制台能看到 storage.objects / storage.buckets 上的 RLS 策略），
// 而 @cloudbase/node-sdk 3.x 只实现了传统模式通道（getUploadMetadata + 直传 COS），
// 压根没有 `app.storage.from(bucketId)` 这套原生桶语义。
// 用错通道的症状是：上传必然失败，且报错与 RLS / 密钥权限全都无关，极难倒推。
//
// 这里用一个**本地假网关**把 PG 通道完整跑一遍：上传走 POST /v1/storages/object/:bucket/:name，
// 取链接走 POST /v1/storages/object/sign/:bucket/:name。
// 跑法：node test/storage-pg.test.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

// ---------- 假网关 ----------
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    received.push({ method: req.method, url: req.url, headers: req.headers, size: body.length });
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (!String(req.headers.authorization || "").startsWith("Bearer ")) {
      return send(401, { code: "MISSING_CREDENTIALS", message: "Credentials missing.", requestId: "req-401" });
    }
    if (req.url.startsWith("/v1/storages/object/sign/")) {
      if (req.url.includes("missing")) {
        return send(400, { code: "OBJECT_NOT_FOUND", message: "对象不存在", requestId: "req-sign-400" });
      }
      const objectName = decodeURIComponent(req.url.slice("/v1/storages/object/sign/".length));
      return send(200, { signedURL: `/signed/${objectName}`, fullSignedURL: `https://cdn.example.com/signed/${objectName}?token=abc` });
    }
    if (req.url.startsWith("/v1/storages/object/")) {
      if (req.url.includes("reject-me")) {
        return send(403, { code: "RLS_DENIED", message: "new row violates row-level security policy", requestId: "req-403" });
      }
      const objectName = decodeURIComponent(req.url.slice("/v1/storages/object/".length));
      return send(200, { Id: "550e8400-e29b-41d4-a716-446655440000", Key: objectName });
    }
    send(404, { code: "NOT_FOUND", message: "no route" });
  });
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// uploads.js 在模块加载时读环境变量，所以必须先设好再 import。
// 回落路径会写本地磁盘，指到临时目录，别在 api/uploads 里堆测试垃圾。
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-pg-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.CLOUDBASE_ENV_ID = `127.0.0.1:${port}`;
process.env.CLOUDBASE_APIKEY = "service-role-test-key";
process.env.CLOUDBASE_BUCKET = "aquarium-assets";
process.env.CLOUDBASE_STORAGE_MODE = "pg";

const mod = await import("../uploads.js?pg-test");
// 模块内部用 `https://${env}.api.tcloudbasegateway.com`，测试要打本地 http 网关，
// 这里把拼好的地址替换掉，等价于把网关搬到本地。
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => originalFetch(String(url).replace(/^https:\/\/127\.0\.0\.1:\d+\.api\.tcloudbasegateway\.com/, `http://127.0.0.1:${port}`), options);

const { storeAudio, resolveCloudUrl, resolveAudioPaths, parsePgRef, pgRef, storageMode, PG_REF_SCHEME } = mod;

console.log("--- 模式与引用 ---");
chk("默认按 PG 模式", storageMode(), "pg");
chk("pg 引用前缀", PG_REF_SCHEME, "tcbpg://");
chk("拼引用", pgRef("aquarium-assets", "sounds/a.mp3"), "tcbpg://aquarium-assets/sounds/a.mp3");
chk("解析引用", parsePgRef("tcbpg://aquarium-assets/sounds/a.mp3"), { bucket: "aquarium-assets", objectName: "sounds/a.mp3" });
chk("解析带子目录的引用", parsePgRef("tcbpg://bkt/a/b/c.png"), { bucket: "bkt", objectName: "a/b/c.png" });

console.log("--- 上传走 Storage API 网关 ---");
received.length = 0;
const audio = await storeAudio({ buffer: Buffer.from("ID3fake"), originalName: "海浪.mp3", mimeType: "audio/mpeg" }, "sounds");
chk("driver 是 cloudbase", audio.driver, "cloudbase");
chk("返回的是 tcbpg 引用", audio.path.startsWith("tcbpg://aquarium-assets/sounds/"), true);
chk("cloudPath 落在 sounds/ 下", audio.cloudPath.startsWith("sounds/"), true);
chk("传统模式的 url 字段为空（由出库解析补）", audio.url, "");
chk("只打了一次网关", received.length, 1);
chk("方法 POST", received[0].method, "POST");
chk("路径带 bucket 与对象名", received[0].url.startsWith("/v1/storages/object/aquarium-assets/sounds/"), true);
chk("带上 Bearer 凭据", received[0].headers.authorization, "Bearer service-role-test-key");
chk("Content-Type 用真实 MIME", received[0].headers["content-type"], "audio/mpeg");
chk("x-upsert 允许覆盖", received[0].headers["x-upsert"], "true");
chk("字节数原样送达", received[0].size, 7);

console.log("--- 图片与后缀 ---");
received.length = 0;
const image = await storeAudio({ buffer: Buffer.from("89504e47", "hex"), originalName: "fish.png", kind: "image", mimeType: "image/png" }, "images");
chk("图片落在 images/ 下", image.cloudPath.startsWith("images/"), true);
chk("图片保留 .png 后缀", image.cloudPath.toLowerCase().endsWith(".png"), true);
chk("图片 MIME 正确", received[0].headers["content-type"], "image/png");

console.log("--- 对象名里的中文与空格要编码 ---");
received.length = 0;
const odd = await storeAudio({ buffer: Buffer.from("x"), originalName: "我的 海浪.mp3", mimeType: "audio/mpeg" }, "sounds");
chk("URL 里没有裸空格", received[0].url.includes(" "), false);
chk("URL 里没有裸中文", /[\u4e00-\u9fa5]/.test(received[0].url), false);
chk("引用里保留可读原名", decodeURIComponent(odd.cloudPath).includes("海浪"), true);

console.log("--- 取下载链接走 sign 接口 ---");
received.length = 0;
const signed = await resolveCloudUrl(audio.path);
chk("拿到 fullSignedURL", signed.startsWith("https://cdn.example.com/signed/"), true);
chk("sign 用 POST", received[0].method, "POST");
chk("sign 路径正确", received[0].url.startsWith("/v1/storages/object/sign/aquarium-assets/sounds/"), true);
chk("带上 Bearer 凭据", received[0].headers.authorization, "Bearer service-role-test-key");

console.log("--- 链接缓存（同一引用只打一次网关）---");
received.length = 0;
await resolveCloudUrl(audio.path);
chk("命中缓存，不再打网关", received.length, 0);

console.log("--- 网关报错要带出 code 与 requestId ---");
// storeAudio 的契约：云存储失败不抛错，而是回落到本地磁盘，
// 并把真实原因放进 fallbackError / fallbackCode，让后台拒绝写入死链。
const rejected = await storeAudio({ buffer: Buffer.from("x"), originalName: "reject-me.mp3", mimeType: "audio/mpeg" }, "sounds");
chk("失败时回落到本地", rejected.driver, "local");
chk("标出是从云存储回落", rejected.fallbackFrom, "cloudbase");
chk("fallbackError 是网关原文", rejected.fallbackError, "new row violates row-level security policy");
chk("fallbackCode 带出来", rejected.fallbackCode, "RLS_DENIED");

console.log("--- 解析失败时原样返回引用，不炸掉整份配置 ---");
const broken = await resolveAudioPaths({ a: "tcbpg://aquarium-assets/missing/obj.mp3", b: "plain/path.mp3" });
chk("解析不了就保留原引用", broken.a, "tcbpg://aquarium-assets/missing/obj.mp3");
chk("普通路径原样返回", broken.b, "plain/path.mp3");

console.log("--- 非云存储的值不动它 ---");
chk("cloud:// 之外的字符串原样返回", await resolveCloudUrl("/uploads/sounds/a.mp3"), "/uploads/sounds/a.mp3");
chk("数字原样返回", await resolveAudioPaths(42), 42);
chk("null 原样返回", await resolveAudioPaths(null), null);

console.log("----");
console.log(`storage-pg.test: PASS=${pass} FAIL=${fail}`);
globalThis.fetch = originalFetch;
server.close();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
