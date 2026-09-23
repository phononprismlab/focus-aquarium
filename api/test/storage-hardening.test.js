// 存储与上传层的加固（B4 / B6 / B7 / B8 / B9）。
//
// 这一批坑点有个共同点：**服务照常起来，问题只在特定时刻才暴露**。
//   B7  上传的 MIME 信了客户端上报值 —— octet-stream 原样存进桶元数据，文件在但放不出来。
//   B6  每个公开请求对每个云引用都打一次网关 —— 冷缓存时延迟叠加、还撞限流。
//   B8  云上传失败静默回落到容器本地磁盘 —— 配置里留下 /uploads/ 死链，后台还以为存成功了。
//   B9  currentDriver() 与 storageMode() 是两个独立旋钮 —— 能配出自相矛盾的组合。
//   B4  密钥没存储权限，只有真传一次才暴露，而且失败还可能被回落掩盖。
//
// 跑法：node test/storage-hardening.test.js
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
const gateway = { maxInFlight: 0, inFlight: 0 };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const send = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    // 网关根路径：未鉴权请求回 401，启动探测就是拿它判断"域名通不通"。
    if (req.method === "GET" && req.url === "/") {
      return send(401, { message: "unauthorized" });
    }
    received.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString() });
    if (req.url.startsWith("/v1/storages/object/sign/")) {
      // 人为延迟，好让并发上限能被观察到（否则请求瞬间就跑完了）。
      gateway.inFlight += 1;
      gateway.maxInFlight = Math.max(gateway.maxInFlight, gateway.inFlight);
      await new Promise(r => setTimeout(r, 40));
      gateway.inFlight -= 1;
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

// uploads.js 在模块加载时读环境变量，必须先设好再 import。
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-harden-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.CLOUDBASE_ENV_ID = `127.0.0.1:${port}`;
process.env.CLOUDBASE_APIKEY = "service-role-test-key";
process.env.CLOUDBASE_BUCKET = "bkt";
process.env.CLOUDBASE_STORAGE_MODE = "pg";
process.env.CLOUDBASE_SIGN_TTL_SECONDS = "86400";
process.env.CLOUDBASE_RESOLVE_CONCURRENCY = "3";
delete process.env.NODE_ENV;
delete process.env.STORAGE_DRIVER;
delete process.env.ALLOW_LOCAL_FALLBACK;

const mod = await import("../uploads.js?harden-test");
// 只有"端口正好等于假网关"的那个 env 才改写成本地 http；
// 换成别的 host（如 x.invalid）时不改写，好让"网关不可达"这条路径也测得到。
const originalFetch = globalThis.fetch;
const rewritePattern = new RegExp(`^https://127\\.0\\.0\\.1:${port}\\.api\\.tcloudbasegateway\\.com`);
globalThis.fetch = (url, options) => originalFetch(String(url).replace(rewritePattern, `http://127.0.0.1:${port}`), options);

const {
  storeAudio, resolveAudioPaths, storagePlan, storageStatus, probeStorageGateway,
  currentDriver, storageMode, effectiveMimeType, URL_TTL_MS, SIGN_TTL_SECONDS
} = mod;

console.log("--- B7 MIME 归一化：不信客户端上报值 ---");
chk("可信的上报值原样采用", effectiveMimeType("audio", "a.mp3", "audio/mpeg"), "audio/mpeg");
chk("空值按后缀重算", effectiveMimeType("audio", "a.mp3", ""), "audio/mpeg");
chk("octet-stream 按后缀重算", effectiveMimeType("image", "fish.png", "application/octet-stream"), "image/png");
chk("与 kind 不符的上报值被丢掉", effectiveMimeType("audio", "a.mp3", "image/png"), "audio/mpeg");
chk("带参数的上报值去掉参数", effectiveMimeType("audio", "a.mp3", "audio/mpeg; charset=utf-8"), "audio/mpeg");
chk("未知后缀用 kind 默认值兜底", effectiveMimeType("image", "a.unknown", ""), "image/png");
chk("wav 后缀", effectiveMimeType("audio", "click.wav", "application/octet-stream"), "audio/wav");
chk("svg 后缀", effectiveMimeType("image", "a.svg", "application/octet-stream"), "image/svg+xml");

console.log("--- B7 网关收到的是纠正后的 MIME ---");
received.length = 0;
await storeAudio({ buffer: Buffer.from("x"), originalName: "shell.png", kind: "image", mimeType: "application/octet-stream" }, "images");
chk("octet-stream 被纠正成 image/png", received[0].headers["content-type"], "image/png");

console.log("--- B4 上传成功后状态会被记下来 ---");
chk("状态是 ok", storageStatus().upload, "ok");
chk("成功时不留错误信息", storageStatus().lastError, "");

console.log("--- B6 同一引用的并发解析合并成一次 ---");
received.length = 0;
const dup = "tcbpg://bkt/sounds/dup.mp3";
const [d1, d2, d3] = await Promise.all([resolveAudioPaths(dup), resolveAudioPaths(dup), resolveAudioPaths(dup)]);
chk("三次并发解析结果一致", [d1, d2, d3].every(v => v === d1), true);
chk("只打了一次网关", received.filter(r => r.url.includes("/sign/")).length, 1);

console.log("--- B6 并发上限：不一次性轰出去 ---");
received.length = 0;
gateway.maxInFlight = 0;
const twelve = Array.from({ length: 12 }, (_, i) => `tcbpg://bkt/sounds/n${i}.mp3`);
const resolved12 = await Promise.all(twelve.map(ref => resolveAudioPaths(ref)));
chk("12 个引用全部解析成功", resolved12.every(v => typeof v === "string" && v.startsWith("https://cdn.example.com/signed/")), true);
chk("网关并发没超过配置上限 3", gateway.maxInFlight <= 3, true);
chk("确实打满了上限（说明限流真在生效）", gateway.maxInFlight > 1, true);
const signBodies = received.filter(r => r.url.includes("/sign/")).map(r => JSON.parse(r.body || "{}"));
chk("12 个引用各签一次", signBodies.length, 12);
chk("签名有效期用的是同一个常量", signBodies.every(b => b.expiresIn === SIGN_TTL_SECONDS), true);

console.log("--- B6 缓存时长跟着签名有效期走（旧值 30 分钟太短）---");
chk("缓存至少 6 小时", URL_TTL_MS >= 6 * 3600 * 1000, true);
chk("缓存短于签名有效期", URL_TTL_MS < SIGN_TTL_SECONDS * 1000, true);

console.log("--- B8 生产环境不允许回落到容器本地磁盘 ---");
process.env.NODE_ENV = "production";
let thrown = null;
try {
  await storeAudio({ buffer: Buffer.from("x"), originalName: "reject-me.mp3", mimeType: "audio/mpeg" }, "sounds");
} catch (error) {
  thrown = error;
}
chk("生产环境下云上传失败会抛错而不是回落", Boolean(thrown), true);
chk("错误码带出来", thrown && thrown.code, "RLS_DENIED");
chk("错误里说清了为什么不回落", Boolean(thrown && String(thrown.message).includes("不允许写入容器本地磁盘")), true);
chk("状态被记成 failed", storageStatus().upload, "failed");
chk("状态码进状态里", storageStatus().lastErrorCode, "RLS_DENIED");
chk("记了失败时间", storageStatus().lastErrorAt > 0, true);

console.log("--- B8 回落可以被显式打开 ---");
process.env.ALLOW_LOCAL_FALLBACK = "1";
const allowed = await storeAudio({ buffer: Buffer.from("x"), originalName: "reject-me.mp3", mimeType: "audio/mpeg" }, "sounds");
chk("显式打开后生产也允许回落", allowed.driver, "local");
process.env.ALLOW_LOCAL_FALLBACK = "";
process.env.NODE_ENV = "";
const devFallback = await storeAudio({ buffer: Buffer.from("x"), originalName: "reject-me.mp3", mimeType: "audio/mpeg" }, "sounds");
chk("非生产环境保持原回落行为", devFallback.driver, "local");
chk("回落仍然带上真实原因", devFallback.fallbackCode, "RLS_DENIED");

console.log("--- B9 存储决策只有一个来源 ---");
chk("驱动由 storagePlan 派生", currentDriver(), storagePlan().driver);
chk("模式由 storagePlan 派生", storageMode(), storagePlan().mode);
chk("当前是 cloudbase", storagePlan().driver, "cloudbase");
chk("当前是 pg", storagePlan().mode, "pg");
chk("桶名带出来", storagePlan().bucket, "bkt");
chk("配置正常时没有问题", storagePlan().problems, []);

process.env.NODE_ENV = "production";
process.env.STORAGE_DRIVER = "local";
chk("生产 + local 被判成问题", storagePlan().problems.length, 1);
chk("问题说明了后果", (storagePlan().problems[0] || "").includes("404"), true);
process.env.STORAGE_DRIVER = "cloudbase";

const savedEnvId = process.env.CLOUDBASE_ENV_ID;
delete process.env.CLOUDBASE_ENV_ID;
chk("cloudbase 缺 envId 被判成问题", storagePlan().problems.some(p => p.includes("CLOUDBASE_ENV_ID")), true);
process.env.CLOUDBASE_ENV_ID = savedEnvId;

const savedKey = process.env.CLOUDBASE_APIKEY;
delete process.env.CLOUDBASE_APIKEY;
delete process.env.CLOUDBASE_STORAGE_TOKEN;
chk("pg 缺密钥被判成问题", storagePlan().problems.some(p => p.includes("CLOUDBASE_APIKEY")), true);
process.env.CLOUDBASE_APIKEY = savedKey;

process.env.NODE_ENV = "";
process.env.STORAGE_DRIVER = "";
chk("恢复后不再报问题", storagePlan().problems, []);

console.log("--- B4 网关可达性探测 ---");
chk("网关可达时被认出来（401 属正常）", await probeStorageGateway({ timeoutMs: 2000 }), "reachable");
chk("状态记成 reachable", storageStatus().gateway, "reachable");
process.env.CLOUDBASE_ENV_ID = "probe-unreachable.invalid";
chk("网关不可达时被认出来", await probeStorageGateway({ timeoutMs: 2000 }), "unreachable");
chk("状态记成 unreachable", storageStatus().gateway, "unreachable");
process.env.CLOUDBASE_ENV_ID = savedEnvId;
process.env.STORAGE_DRIVER = "local";
chk("不走云存储时跳过探测", await probeStorageGateway({ timeoutMs: 2000 }), "skipped");
process.env.STORAGE_DRIVER = "";

console.log("----");
console.log(`storage-hardening.test: PASS=${pass} FAIL=${fail}`);
globalThis.fetch = originalFetch;
server.close();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
