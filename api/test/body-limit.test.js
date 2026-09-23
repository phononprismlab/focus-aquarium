// 请求体兜底错误处理（B11）。
//
// 以前 express.json 的 413 / JSON 语法错误会落到 Express 默认处理器，
// 返回一坨 HTML，后台拿到的只是「请求失败」四个字 —— 于是有人会把图片转成
// base64 塞进配置，撞上 2MB 上限后完全不知道该干什么。
// 现在这两类错误翻成人话，并且明确指出图片有专门的上传接口。
//
// 顺带锁住一件事：/uploads 静态目录用 fallthrough:false，缺文件时会 next 一个 404，
// 新增的兜底错误处理必须保留它的 404，不能一律打成 500（否则「图片不存在」会被误判成服务端故障）。
//
// 跑法：node test/body-limit.test.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 8123;
const KEY = "body-limit-test-key-0123456789";
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-body-"));
// 上限故意设得很小，测试不必真发 2MB。
const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(PORT),
  EXTRA_PORTS: "0",
  ADMIN_API_KEY: KEY,
  JSON_BODY_LIMIT: "1kb",
  UPLOAD_DIR
};
delete env.CLOUDBASE_ENV_ID;

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

const child = spawn(process.execPath, ["server.js"], { env, cwd: path.join(process.cwd()), stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => (log += d));
child.stderr.on("data", d => (log += d));

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method, headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, contentType: res.headers["content-type"] || "" }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitForPort(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await request("GET", "/api/health");
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return false;
}

function jsonOf(res) {
  try { return JSON.parse(res.body); } catch { return {}; }
}

try {
  if (!(await waitForPort())) {
    console.log("FAIL | 服务未在预期时间内启动");
    console.log(log);
    child.kill();
    process.exit(1);
  }

  console.log("--- 超限的请求体要说人话（B11）---");
  const big = JSON.stringify({ id: "x", category: "decor", name: "x".repeat(5000) });
  let res = await request("POST", "/api/admin/decorations", big, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(big),
    "x-admin-key": KEY
  });
  chk("超限返回 413", res.status, 413);
  chk("返回的是 JSON 而不是 HTML", res.contentType.includes("application/json"), true);
  const bigBody = jsonOf(res);
  chk("有 error 字段", typeof bigBody.error, "string");
  chk("指出超出了上限", String(bigBody.error).includes("超过上限"), true);
  chk("指出图片该走上传接口", String(bigBody.error).includes("/api/admin/assets/image"), true);
  chk("明确反对 base64 塞配置", String(bigBody.error).includes("base64"), true);

  console.log("--- JSON 语法错误要说人话 ---");
  const broken = "{ this is not json ";
  res = await request("POST", "/api/admin/decorations", broken, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(broken),
    "x-admin-key": KEY
  });
  chk("语法错误返回 400", res.status, 400);
  chk("错误说明是 JSON 语法问题", String(jsonOf(res).error || "").includes("合法 JSON"), true);

  console.log("--- 兜底处理不能误伤正常请求 ---");
  const small = JSON.stringify({ id: "tiny", category: "decor", name: "小摆件" });
  res = await request("POST", "/api/admin/decorations", small, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(small),
    "x-admin-key": KEY
  });
  chk("正常大小的请求照常通过", res.status, 201);

  console.log("--- /uploads 缺文件仍然是 404，不能被打成 500 ---");
  res = await request("GET", "/uploads/not-here.png");
  chk("缺文件返回 404", res.status, 404);
  chk("404 也是 JSON", res.contentType.includes("application/json"), true);
  chk("404 的错误文案", jsonOf(res).error, "资源不存在");
} finally {
  child.kill();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
}

console.log("----");
console.log(`body-limit.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
