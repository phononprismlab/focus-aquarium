// B1 回归测试：后台 GET 绝不能解析云存储引用。
// B13 回归测试：公开 GET 对 **fish** 类型也必须解析（见下方 fish 段）。
//
// 根因：server.js 对 /api/admin/:type 也调用了 resolveAudioPaths()，把 tcbpg:// 换成了
// 1 小时过期的签名 URL；后台编辑并保存时会把这个临时链接永久写回配置。
// 修复后：只有公开接口 /api/game/:type 才解析，后台接口返回原始持久化引用。
//
// 为了让"解析成功"在测试中真实发生（否则新旧代码都返回原值，测不出差异），
// 用本地假网关 + 重定向 globalThis.fetch（同 storage-pg.test.js）：
//   - CLOUDBASE_ENV_ID 设为合法主机名 test-env，网关基地址变成 https://test-env.api.tcloudbasegateway.com
//   - 把该域名的请求重定向到本地假网关，假网关对 storage 接口返回签名 URL
// 仓库用内存替身（setRepositoryForTest）注入，避免连真实云环境。
//
// 反向验证：本测试在修复后的代码上 PASS；在修复前的 server.js（后台 GET 也调用 resolveAudioPaths）
// 上会 FAIL（后台 GET 返回签名 URL 而非 tcbpg://）。
//
// 跑法：node test/admin-resolution.test.js
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

// ---------- 假网关：storage 接口返回签名 URL，其余返回空 data ----------
const gw = http.createServer((req, res) => {
  const send = (code, payload) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (String(req.headers.authorization || "").startsWith("Bearer ")) {
    if (req.url.startsWith("/v1/storages/object/sign/")) {
      const objectName = decodeURIComponent(req.url.slice("/v1/storages/object/sign/".length));
      return send(200, { signedURL: `/signed/${objectName}`, fullSignedURL: `https://cdn.example.com/signed/${objectName}?token=abc` });
    }
    if (req.url.startsWith("/v1/storages/object/")) {
      const objectName = decodeURIComponent(req.url.slice("/v1/storages/object/".length));
      return send(200, { Id: "id-1", Key: objectName });
    }
  }
  return send(200, { data: [], requestId: "gw", success: true });
});
await new Promise(resolve => gw.listen(0, "127.0.0.1", resolve));
const gwPort = gw.address().port;

// 必须在 import server.js 之前设好环境变量。
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-admin-"));
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.PORT = "8141";
process.env.EXTRA_PORTS = "0";
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-b1";
process.env.CLOUDBASE_ENV_ID = "test-env"; // 合法主机名，仅用于拼网关基地址
process.env.CLOUDBASE_APIKEY = "service-role-test-key";
process.env.CLOUDBASE_BUCKET = "aquarium-assets";
process.env.CLOUDBASE_STORAGE_MODE = "pg";

// 把 *.api.tcloudbasegateway.com 的请求重定向到本地假网关。
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  originalFetch(String(url).replace(/^https:\/\/test-env\.api\.tcloudbasegateway\.com/, `http://127.0.0.1:${gwPort}`), options);

// 本地 http 客户端
function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: 8141, path: p, method, headers: { "content-type": "application/json", ...headers } },
      res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log("--- 启动服务（import server.js + 注入内存仓库 + startServer）---");
const server = await import("../server.js");
const { createMemoryRepository } = await import("../repository.js");
server.setRepositoryForTest(createMemoryRepository());
await server.startServer();

const health = JSON.parse((await request("GET", "/api/health")).body || "{}");
console.log(`     health: storage=${health.storage} storageMode=${health.storageMode} repository=${health.repository}`);
chk("公开接口健康检查可用", health.ok, true);

const CANONICAL = "tcbpg://aquarium-assets/sounds/ocean-wave.mp3";
const decoration = {
  id: "b1-test-001",
  category: "sounds",
  name: "测试白噪音",
  description: "B1 回归用",
  resourcePath: [CANONICAL],
  price: 10,
  isMemberOnly: false,
  maxInventory: 1
};

// 写入一条带云存储引用的商品
const saved = await request("POST", "/api/admin/decorations", decoration, { "x-admin-key": "test-admin-key-b1" });
chk("写入商品 -> 201", saved.status, 201);

// 公开接口只返回已发布的项，先发布（模拟后台"保存后点发布"的两步操作）。
const pub = await request("POST", "/api/admin/decorations/b1-test-001/publish", null, { "x-admin-key": "test-admin-key-b1" });
chk("发布商品 -> 200", pub.status, 200);

// 关键断言 1：后台 GET 必须原样返回持久化引用，绝不能解析成签名 URL
// 注意：列表接口返回的 data 是记录数组，每条带 .data 字段（与前端一致）。
const adminList = JSON.parse((await request("GET", "/api/admin/decorations", null, { "x-admin-key": "test-admin-key-b1" })).body || "{}");
const adminItem = (adminList.data || []).find(d => d.id === "b1-test-001");
chk("后台 GET 返回了该商品", Boolean(adminItem), true);
chk("后台 GET 不解析云引用（仍为 tcbpg://）", adminItem && adminItem.data && adminItem.data.resourcePath && adminItem.data.resourcePath[0], CANONICAL);
chk("后台 GET 没有把引用变成签名 URL", !String((adminItem && adminItem.data && adminItem.data.resourcePath && adminItem.data.resourcePath[0]) || "").startsWith("https://"), true);

// 关键断言 2：公开 GET 仍然解析成可播放的签名链接（修复不能误伤公开接口）
const gameList = JSON.parse((await request("GET", "/api/game/decorations")).body || "{}");
const gameItem = (gameList.data || []).find(d => d.id === "b1-test-001");
chk("公开 GET 返回了该商品", Boolean(gameItem), true);
chk("公开 GET 解析成签名 URL（https://）", String((gameItem && gameItem.data && gameItem.data.resourcePath && gameItem.data.resourcePath[0]) || "").startsWith("https://"), true);

// ===== B13：fish 类型的云引用也必须被解析 =====
// 根因：PUBLIC_PATH_RESOLVE_TYPES 原本是 ["audio","decorations"]，**漏了 fish**。
// 后果：后台上传的鱼资源（tcbpg://）下发到 /api/game/fish 时是裸引用 →
//       玩家端 <img src="tcbpg://…"> 直接 404 → 鱼根本不显示。
//       这是「鱼类装配：资源从后台真实读取」的阻塞项。
const FISH_CANONICAL = "tcbpg://aquarium-assets/fish/clownfish-body.png";
const fish = {
  fishid: "b13-test-fish",
  name: "测试鱼",
  resourcePath: [FISH_CANONICAL],
  scaleMin: 0.8,
  scaleMax: 1.1,
  feedReaction: true,
  animationCode: "fish.speed = 3;"
};
const savedFish = await request("POST", "/api/admin/fish", fish, { "x-admin-key": "test-admin-key-b1" });
chk("写入鱼 -> 201", savedFish.status, 201);
const pubFish = await request("POST", "/api/admin/fish/b13-test-fish/publish", null, { "x-admin-key": "test-admin-key-b1" });
chk("发布鱼 -> 200", pubFish.status, 200);

// fish 的 id 取自 data.fishid（不是 data.id）
const adminFishList = JSON.parse((await request("GET", "/api/admin/fish", null, { "x-admin-key": "test-admin-key-b1" })).body || "{}");
const adminFish = (adminFishList.data || []).find(d => d.id === "b13-test-fish");
chk("后台 GET 返回了该鱼", Boolean(adminFish), true);
chk("后台 GET 鱼不解析云引用（仍为 tcbpg://）", adminFish && adminFish.data && adminFish.data.resourcePath && adminFish.data.resourcePath[0], FISH_CANONICAL);

// 关键断言（B13）：公开 GET /api/game/fish 必须解析成签名 URL，否则鱼图 404
const gameFishList = JSON.parse((await request("GET", "/api/game/fish")).body || "{}");
const gameFish = (gameFishList.data || []).find(d => d.id === "b13-test-fish");
chk("公开 GET 返回了该鱼", Boolean(gameFish), true);
chk("公开 GET 鱼解析成签名 URL（B13）", String((gameFish && gameFish.data && gameFish.data.resourcePath && gameFish.data.resourcePath[0]) || "").startsWith("https://"), true);

// ===== F3 紧急总开关：FISHTANK_DISABLE_CUSTOM_CODE =====
chk("公开 GET 默认带 animationCode", gameFish && gameFish.data && gameFish.data.animationCode, "fish.speed = 3;");
process.env.FISHTANK_DISABLE_CUSTOM_CODE = "1";
const gameFishDisabled = (JSON.parse((await request("GET", "/api/game/fish")).body || "{}").data || []).find(d => d.id === "b13-test-fish");
chk("总开关打开后不再下发 animationCode", Boolean(gameFishDisabled && gameFishDisabled.data && ("animationCode" in gameFishDisabled.data)), false);
chk("总开关只剥动画代码，资源仍在", Boolean(gameFishDisabled && gameFishDisabled.data && gameFishDisabled.data.resourcePath && gameFishDisabled.data.resourcePath[0]), true);
delete process.env.FISHTANK_DISABLE_CUSTOM_CODE;

console.log("----");
console.log(`admin-resolution.test: PASS=${pass} FAIL=${fail}`);
globalThis.fetch = originalFetch;
gw.close();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
