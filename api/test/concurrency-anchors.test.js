// T2-5 / T2-7 的**源码静态锚**：把「并发保护」和「会话落库」的关键实现钉死。
//
// 为什么除了行为测试还要有静态锚：
//   1. 行为测试跑在内存实现上，能证明语义；但云实现（driver:"cloudbase"）的
//      expectUpdatedAt 那一行如果被人删掉，内存测试**依然是绿的** —— 只有真部署出去
//      才会发现并发保护没了。所以要在源码层面钉住「两个实现都带乐观锁」。
//   2. T2-7 的 persistence 三方法接线（findSession/consumeSession/settleSession）
//      一旦漏接，症状是「本地测全绿、线上跨实例结算 404」—— 同样的隐性回归。
//
// 这类断言剥注释后再扫，避免注释里提到的词造成假通过。
// 运行：node test/concurrency-anchors.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}
function chkTrue(name, condition, detail = "") {
  const ok = condition === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}

const read = f => fs.readFileSync(path.join(apiDir, f), "utf8");
// 剥掉注释：注释里写着的名字不算实现。
//
// 🔴 顺序很重要：**先剥行注释，再剥块注释**。
//    反过来的话，一句行注释里出现的 `/*`（比如「……支持 /* 通配……」这类说明文字）
//    会跟很远之后的另一个 `/*` 配成一对，把中间成百上千行真代码一起吞掉 ——
//    表现是「明明实现了，断言却说没有」，而且极难看出原因。
//    （本文件就是这么被坑过一次：player-store.js 第 760 行一个 `/*` 吞掉了
//      createCloudbasePlayerStore 的整个前半段。）
//
// 行注释判定：行首（可带空白）是 `//`。行内的 `//` 不动 —— 本仓库代码里
// 没有「代码 // 行尾注释」这种写法，且真剥了会误伤字符串里的 `https://`。
const stripComments = src => src
  .replace(/\r\n?/g, "\n")
  .replace(/^[ \t]*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const count = (src, re) => (src.match(re) || []).length;

const storeSrc = stripComments(read("player-store.js"));
const serverSrc = stripComments(read("server.js"));
const sessionSrc = stripComments(read("focus-session.js"));

// ===== 1. 内存实现的乐观锁 =====
console.log("\n--- 1. 内存实现：putSave 支持 expectUpdatedAt ---");
chkTrue("内存 putSave 的签名里有 expectUpdatedAt",
  /async putSave\(uid, data, \{[^}]*expectUpdatedAt[^}]*\}\s*=\s*\{\}\)/.test(storeSrc));
chkTrue("版本不符时返回 conflict（而不是默默覆盖）",
  /currentVersion\s*!==\s*Number\(expectUpdatedAt\)/.test(storeSrc) && /conflict:\s*true/.test(storeSrc));

// ===== 2. 云实现的乐观锁（🔴 内存测试覆盖不到的部分）=====
console.log("\n--- 2. 云实现：WHERE 条件 + 回读校验缺一不可 ---");
chkTrue("云 putSave 的签名里有 expectUpdatedAt",
  count(storeSrc, /expectUpdatedAt\s*=\s*null\s*\}\s*=\s*\{\}\)/g) >= 2,
  `出现 ${count(storeSrc, /expectUpdatedAt\s*=\s*null\s*\}\s*=\s*\{\}\)/g)} 次（内存+云各一）`);
chkTrue("🔴 UPDATE 的 WHERE 里真的带上了版本条件",
  /\.eq\("updated_at",\s*expectUpdatedAt\)/.test(storeSrc));
chkTrue("🔴 update 之后**回读**确认版本（RDB 不返回影响行数，不回读无法判断成败）",
  /const\s+after\s*=\s*await\s+selectOne\(TABLE_SAVES/.test(storeSrc),
  "云实现必须 selectOne 回读");
chkTrue("回读版本与预期不符 → conflict",
  /currentVersion\s*!==\s*Number\(at\)[\s\S]{0,80}conflict:\s*true/.test(storeSrc));
chkTrue("插入撞主键 → conflict（不覆盖已有存档）",
  /expectUpdatedAt\s*!==\s*null\)\s*return\s*\{\s*conflict:\s*true/.test(storeSrc));

// ===== 3. 服务端重试层 =====
console.log("\n--- 3. 服务端：冲突在服务端内部重试，对前端透明 ---");
chkTrue("定义了重试上限常量", /const SAVE_WRITE_MAX_ATTEMPTS\s*=\s*\d+/.test(serverSrc));
chkTrue("冲突时 continue 重试（而不是把冲突抛给前端）",
  /row\s*&&\s*row\.conflict[\s\S]{0,200}continue;/.test(serverSrc));
chkTrue("每次重试都**重新读库**（拿最新基线重算 plan）",
  /for\s*\(let attempt = 1; attempt <= SAVE_WRITE_MAX_ATTEMPTS; attempt\+\+\)\s*\{\s*const stored = await store\.getSave\(uid\)/.test(serverSrc));
chkTrue("写时把读到的版本作为前置条件传下去",
  /expectUpdatedAt:\s*Number\(stored\.updated_at\)\s*\|\|\s*0/.test(serverSrc));
chkTrue("🔴 plan 自己判定失败（余额不足等）→ 不重试，直接交回调用方",
  /planned\s*&&\s*planned\.error\)\s*return\s*\{\s*row:\s*null,\s*stored,\s*plan:\s*planned,\s*failed:\s*true\s*\}/.test(serverSrc));

// ===== 4. 三条写路径全部接入 =====
console.log("\n--- 4. 三条写路径都必须走重试层（漏一条就是漏一个并发口子）---");
chk("writeSaveWithRetry 的调用点数量", count(serverSrc, /await writeSaveWithRetry\(/g), 3);

// ===== 5. 409 契约保留 =====
console.log("\n--- 5. 409 语义（前端契约）没有被乐观锁顺手改掉 ---");
chkTrue("PUT /api/game/save 缺云存档时 503 而不是冲突码",
  /return res\.status\(503\)\.json\(\{ error: "存档正在被另一个设备修改/.test(serverSrc));
chkTrue("shop/buy 保留「没有云存档 → 409」",
  /还没有云存档，请先让本地存档同步一次再购买/.test(serverSrc));
chkTrue("shop/settle 保留「没有云存档 → 409」",
  /还没有云存档，请先让本地存档同步一次再保存鱼缸/.test(serverSrc));
chk("409 出现次数（两条写路径各一）", count(serverSrc, /res\.status\(409\)/g), 2);

// ===== 6. T2-7：会话落库 =====
console.log("\n--- 6. T2-7：专注会话跨实例靠库，不靠内存 Map ---");
chkTrue("focus-session 定义了 persistence 接口约定",
  /findSession\(id\)\s*\/\s*consumeSession\(id\)\s*\/\s*settleSession\(id, patch\)/.test(read("focus-session.js").replace(/\s+/g, " ")),
  "注释里的接口约定");
chkTrue("settle 是 async（要查库）", /async settle\(sessionId, focusConfig, \{ uid = null \} = \{\}\)/.test(sessionSrc));
chkTrue("先查库（权威源）", /await persistence\.findSession\(sessionId\)/.test(sessionSrc));
chkTrue("库查不到才回退内存", /if \(!source && memorySession\) source = memorySession;/.test(sessionSrc));
chkTrue("🔴 归属校验：会话有主人，别人的令牌领不走",
  /source\.uid\s*&&\s*uid\s*&&\s*source\.uid\s*!==\s*String\(uid\)/.test(sessionSrc));
chkTrue("返回 SESSION_OWNER_MISMATCH 错误码", /SESSION_OWNER_MISMATCH/.test(sessionSrc));
chkTrue("🔴 CAS 抢占：consumeSession 返回 false → 说明已被别人领走",
  /const claimed = await persistence\.consumeSession\(sessionId, source\.startedAt\)[\s\S]{0,120}claimed === false/.test(sessionSrc));
chkTrue("isMember 取会话开始时的服务端裁定值（不用结算请求传的）",
  /const memberForReward = source\.isMember === true;/.test(sessionSrc));
chkTrue("过期判断在两条来源上都做", count(sessionSrc, /isExpired\(/g) >= 2);

console.log("\n--- 7. T2-7：服务端接线 ---");
chkTrue("server.js 把三个 persistence 方法接到 playerStore",
  /findSession:\s*async id\s*=>\s*\(await getPlayerStore\(\)\)\.findFocusSession\(id\)/.test(serverSrc) &&
  /consumeSession:\s*async id\s*=>\s*\(await getPlayerStore\(\)\)\.claimFocusSession\(id\)/.test(serverSrc) &&
  /settleSession:\s*async \(id, patch\)\s*=>\s*\(await getPlayerStore\(\)\)\.settleFocusRecord\(id, patch\)/.test(serverSrc));
chkTrue("start 把 uid 一起记进会话",
  /focusSessions\.start\(\{[\s\S]{0,200}uid:/.test(serverSrc));
chkTrue("complete 把请求者 uid 传给 settle 做归属校验",
  /focusSessions\.settle\(sessionId, focusConfig, \{\s*uid:/.test(serverSrc));
chkTrue("归属不符 → 403", /settlement\.error[\s\S]{0,120}403/.test(serverSrc));
chkTrue("🔴 结算结果不再重复写库（settle 内部已通过 persistence 写）",
  /不再在这里写库/.test(read("server.js")), "认注释标记");

// ===== 8. player-store 的会话持久化方法 =====
console.log("\n--- 8. player-store：findFocusSession / claimFocusSession ---");
chk("findFocusSession 定义数量（内存 + 云）", count(storeSrc, /async findFocusSession\(/g), 2);
chk("claimFocusSession 定义数量（内存 + 云）", count(storeSrc, /async claimFocusSession\(/g), 2);
chkTrue("🔴 抢占用 CAS：WHERE 里带 settled_at = 0（只有未被领走的才能改）",
  /\.eq\("settled_at",\s*0\)/.test(storeSrc));
chkTrue("抢占后回读确认（RDB 不回传影响行数）",
  /Number\(after\.settled_at\)\s*===\s*claimedAt/.test(storeSrc));
chkTrue("🔴 哨兵值约定：claim 写非 0，settle 用 > 0 判已结算（写 0 会被判成未结算）",
  /Number\(row\.settled_at\)\s*>\s*0\)\s*return\s*\{\s*\.\.\.row,\s*alreadySettled:\s*true\s*\}/.test(storeSrc));

// ===== 9. 诊断探针的门禁 =====
console.log("\n--- 9. 诊断探针：生产环境永不注册 ---");
chkTrue('双门禁：NODE_ENV !== "production" && FISHTANK_DIAG === "1"',
  /process\.env\.NODE_ENV\s*!==\s*"production"\s*&&\s*process\.env\.FISHTANK_DIAG\s*===\s*"1"/.test(serverSrc));
chkTrue("探针回显 instanceId（用来验证多实例）", /instanceId:\s*INSTANCE_ID/.test(serverSrc));
chkTrue("探针回显 trust proxy 与 XFF", /trustProxy:\s*app\.get\("trust proxy"\)/.test(serverSrc));

console.log("\n----");
console.log(`concurrency-anchors.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
