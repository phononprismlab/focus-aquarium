// CORS 来源白名单的测试。
// 重点覆盖"配置里多写一个结尾斜杠"这个坑：Origin 头永远不带路径，
// 而匹配是精确字符串比较，不归一化就会静默拦住前端。
// 运行：node test/cors.test.js
import { parseOrigins, resolveAllowList, createOriginChecker, FALLBACK_ORIGINS } from "../cors.js";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`PASS | ${name} = ${JSON.stringify(actual)}`);
    pass++;
  } else {
    console.log(`FAIL | ${name} 期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
    fail++;
  }
}

// ---------- parseOrigins ----------
console.log("--- parseOrigins ---");
chk("单个来源", parseOrigins("https://a.com"), ["https://a.com"]);
chk("多个来源去空格", parseOrigins(" https://a.com , https://b.com "), ["https://a.com", "https://b.com"]);
chk("空值返回空数组", parseOrigins(""), []);
chk("undefined 返回空数组", parseOrigins(undefined), []);
chk("只有逗号也返回空数组", parseOrigins(" , , "), []);
chk("结尾斜杠被去掉", parseOrigins("https://a.com/"), ["https://a.com"]);
chk("多个结尾斜杠被去掉", parseOrigins("https://a.com///"), ["https://a.com"]);
chk("去掉斜杠后仍保留端口", parseOrigins("http://localhost:8787/"), ["http://localhost:8787"]);
chk("通配符不受影响", parseOrigins("*"), ["*"]);
chk("null 不受影响", parseOrigins("null"), ["null"]);
chk("通配子域不受影响", parseOrigins("*.tcloudbaseapp.com"), ["*.tcloudbaseapp.com"]);
chk("混合写法整体归一化", parseOrigins("https://a.com/, *.b.com ,null"), ["https://a.com", "*.b.com", "null"]);

// ---------- resolveAllowList ----------
console.log("--- resolveAllowList ---");
chk("未配置走兜底名单", resolveAllowList({}).source, "default");
chk("未配置返回内置兜底来源", resolveAllowList({}).origins, FALLBACK_ORIGINS);
chk("配了就走 env", resolveAllowList({ CORS_ORIGINS: "https://a.com" }).source, "env");
chk("env 来源已归一化", resolveAllowList({ CORS_ORIGINS: "https://a.com/" }).origins, ["https://a.com"]);
chk("只有逗号视为未配置", resolveAllowList({ CORS_ORIGINS: "," }).source, "default");

// ---------- createOriginChecker ----------
console.log("--- createOriginChecker ---");
const webapp = "https://focus-aquarium-test-d0gpv0jya4925be19.webapps.tcloudbase.com";

// 真实场景：控制台里手填成了带斜杠的值
const checkerWithSlash = createOriginChecker(resolveAllowList({ CORS_ORIGINS: `${webapp}/` }).origins);
chk("带斜杠配置仍能放行真实 Origin", checkerWithSlash(webapp), true);

const checker = createOriginChecker([webapp]);
chk("精确来源放行", checker(webapp), true);
chk("无 Origin 头（curl / 同域）放行", checker(undefined), true);
chk("空字符串 Origin 放行", checker(""), true);
chk("不同来源拒绝", checker("https://evil.com"), false);
chk("子域不能冒充父域", checker("https://evil." + webapp.replace("https://", "")), false);

const wildcard = createOriginChecker(["*.tcloudbaseapp.com"]);
chk("通配子域放行", wildcard("https://abc.tcloudbaseapp.com"), true);
chk("通配只匹配子域，不匹配裸域", wildcard("https://tcloudbaseapp.com"), false);
chk("通配不匹配其它域", wildcard("https://abc.example.com"), false);

chk("星号放行所有来源", createOriginChecker(["*"])("https://anything.example"), true);
chk("null 规则匹配 file:// 页面", createOriginChecker(["null"])("null"), true);
chk("null 规则不匹配真实来源", createOriginChecker(["null"])("https://a.com"), false);
chk("空规则表全部拒绝（除无 Origin）", createOriginChecker([])("https://a.com"), false);

console.log("----");
console.log(`cors.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
