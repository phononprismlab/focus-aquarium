// 商品预览图上传（Bug 7）的端到端校验。
//
// Bug 7 的根因：后台 admin.html 的 previewUpload.onchange 根本没调后端，
// 只把本地文件名塞进 chip，保存后 previewImage = "xxx.png" 必然 404。
// 这里验证新增的 POST /api/admin/assets/image 真的能收图、落盘、回 URL。
//
// 跑法：node test/image-upload.test.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ⚠️ 必须用测试文件自身的位置推 api/ 目录，**不能用 process.cwd()**：
//    run-unit.mjs 从仓库根启动，cwd 就是仓库根，子进程会把 "server.js" 解析成
//    <仓库根>/server.js（不存在）→ 立刻退出，测试只报「服务未在预期时间内启动」。
const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORT = 8099;
const KEY = "test-key-1234567890";
// 落到临时目录，别在 api/uploads 里堆测试垃圾。
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-upload-"));
const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(PORT),
  EXTRA_PORTS: "0",
  ADMIN_API_KEY: KEY,
  UPLOAD_DIR
};

const child = spawn(process.execPath, ["server.js"], { env, cwd: apiDir, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => (log += d));
child.stderr.on("data", d => (log += d));

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

// 手搓一个 multipart/form-data 请求体（multer 只认这个格式）。
function multipart(field, fileName, contentType, buffer) {
  const boundary = "----focusaquarium" + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(head.length + buffer.length + tail.length) }
  };
}

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// 1x1 透明 PNG，最小合法文件
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8f9ff1f0005fb02fe57c2b8a50000000049454e44ae426082",
  "hex"
);

async function waitForPort(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET" }, res => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 150));
    }
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

const good = multipart("file", "fish.png", "image/png", PNG);
let res = await post("/api/admin/assets/image", good.body, { ...good.headers, "x-admin-key": "" });
chk("无密钥上传图片 -> 401", res.status, 401);

res = await post("/api/admin/assets/image", good.body, { ...good.headers, "x-admin-key": "wrong-key" });
chk("错误密钥上传图片 -> 401", res.status, 401);

res = await post("/api/admin/assets/image", good.body, { ...good.headers, "x-admin-key": KEY });
chk("正确密钥上传图片 -> 200", res.status, 200);
const data = (JSON.parse(res.body) || {}).data || {};
chk("返回 url 非空", Boolean(data.url), true);
chk("driver 有值", Boolean(data.driver), true);
chk("落盘路径在 images/ 下", String(data.path || "").startsWith("images/"), true);
chk("回显原始文件名", data.name, "fish.png");
// 曾经被一律兜成 .mp3：静态服务按后缀发 Content-Type，图片就渲染不出来。
chk("保留图片后缀（不是 .mp3）", /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i.test(String(data.path || "")), true);
chk("后缀不是 .mp3", String(data.path || "").toLowerCase().endsWith(".mp3"), false);
console.log(`     上传结果：driver=${data.driver} path=${data.path} url=${data.url}`);

const bad = multipart("file", "notes.txt", "text/plain", Buffer.from("not-an-image"));
res = await post("/api/admin/assets/image", bad.body, { ...bad.headers, "x-admin-key": KEY });
chk("非图片文件被拒绝", res.status >= 400, true);

// 回归：音频走 sounds/，且这次改后缀逻辑不能把音频带偏。
const wav = multipart("file", "click.wav", "audio/wav", Buffer.from("RIFFfake"));
res = await post("/api/admin/assets", wav.body, { ...wav.headers, "x-admin-key": KEY });
const wavData = (JSON.parse(res.body) || {}).data || {};
chk("wav 保留自身后缀", String(wavData.path || "").toLowerCase().endsWith(".wav"), true);
chk("音频落在 sounds/ 下（与 images/ 分开）", String(wavData.path || "").startsWith("sounds/"), true);

console.log("----");
console.log(`image-upload.test: PASS=${pass} FAIL=${fail}`);
child.kill();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
