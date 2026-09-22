// 背景白噪音播放控制的回归测试（Bug 5）。
//
// 线上现象：每次打开「装点鱼缸」弹窗，背景音都会从头播一遍。
// 触发链是 openShop → await syncPublishedConfig() → loadPublishedConfig() → syncAmbientAudio()，
// 而旧的 syncAmbientAudio 每次都无条件：
//     1) 无条件 waterAudio.play()
//     2) play() 的 then 里再调 fadeInWater()，而 fadeInWater 第一件事是 waterAudio.volume = 0
// 于是每次同步都把音量清零再涨回来，听感上就是"重来一遍"。
// 另外 startWaterNoise() 往 ambientSrc 里存的是 waterAudio.src（浏览器解析后的绝对地址），
// 而 syncAmbientAudio 比较的是 withAssetBase() 给的相对路径，两者永远不等，
// 第一次同步还会真的走 pause() + load() 从头播放。
//
// 这里用假的 Audio 把 syncAmbientAudio 抽出来单独跑，断言"没换音源就什么都不做"。
// 运行：node test/ambient-audio.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

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

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

class FakeAudio {
  constructor(src) {
    this._src = src;
    this.paused = true;
    this.volume = 1;
    this.muted = false;
    this.loop = false;
    this.preload = "";
    this.onerror = null;
    this.playCount = 0;
    this.pauseCount = 0;
    this.loadCount = 0;
  }
  get src() { return this._src; }
  set src(value) { this._src = value; }
  play() { this.playCount++; this.paused = false; return Promise.resolve(); }
  pause() { this.pauseCount++; this.paused = true; }
  load() { this.loadCount++; }
}

function buildSandbox({ id, src, muted = false }) {
  const fadeCalls = [];
  const code = `
let audioMuted = ${muted};
let waterAudio = null;
let ambientSrc = "";
const FALLBACK_AUDIO_SRC = "assets/sounds/water-ambient.mp3";
let currentSrc = ${JSON.stringify(src)};
function currentAmbientId(){ return ${JSON.stringify(id)}; }
function ambientSourceFor(){ return currentSrc; }
function fadeInWater(duration){ fadeCalls.push(duration); if(waterAudio) waterAudio.volume = 0.38; }
${extractFunction(source, "normalizeAudioSrc")}
${extractFunction(source, "fallbackAmbientAudio")}
${extractFunction(source, "syncAmbientAudio")}
return {
  syncAmbientAudio,
  setSource: next => { currentSrc = next; },
  fadeCalls,
  getWaterAudio: () => waterAudio
};`;
  const factory = new Function("Audio", "document", "fadeCalls", code);
  return factory(FakeAudio, { baseURI: "https://app.example.com/index.html" }, fadeCalls);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

console.log("--- 首次启动 ---");
let sandbox = buildSandbox({ id: "water-ambient", src: "assets/sounds/water-ambient.mp3" });
sandbox.syncAmbientAudio();
await tick();
let audio = sandbox.getWaterAudio();
chk("创建了播放器", audio instanceof FakeAudio, true);
chk("循环播放", audio.loop, true);
chk("首次 play 一次", audio.playCount, 1);
chk("首次淡入一次", sandbox.fadeCalls.length, 1);
chk("首次淡入时长", sandbox.fadeCalls[0], 1200);

console.log("\n--- 打开弹窗：音源没变，什么都不该做 ---");
const before = { play: audio.playCount, fade: sandbox.fadeCalls.length, pause: audio.pauseCount, load: audio.loadCount, volume: audio.volume };
sandbox.syncAmbientAudio();
sandbox.syncAmbientAudio();
await tick();
chk("不重复调用 play()", audio.playCount, before.play);
chk("不重复淡入（旧代码会把音量清零再涨回来）", sandbox.fadeCalls.length, before.fade);
chk("不 pause()", audio.pauseCount, before.pause);
chk("不 load()（旧代码从这里开始从头播放）", audio.loadCount, before.load);
chk("音量没有被清零", audio.volume, before.volume);

console.log("\n--- 相对路径 / 绝对路径指向同一个文件，不算换音源 ---");
sandbox.setSource("https://app.example.com/assets/sounds/water-ambient.mp3");
sandbox.syncAmbientAudio();
await tick();
chk("绝对路径不触发重播", audio.playCount, before.play);
chk("绝对路径不触发重新加载", audio.loadCount, before.load);
chk("绝对路径不触发重新淡入", sandbox.fadeCalls.length, before.fade);

console.log("\n--- 玩家在弹窗里换了另一个背景音：应该真的切换 ---");
sandbox.setSource("assets/sounds/ocean.mp3");
sandbox.syncAmbientAudio();
await tick();
chk("换了音源要 pause()", audio.pauseCount, 1);
chk("换了音源要 load()", audio.loadCount, 1);
chk("换了音源重新 play()", audio.playCount, 2);
chk("换了音源重新淡入", sandbox.fadeCalls.length, 2);

console.log("\n--- 播放器被浏览器挂起（paused）时，同步应该把它拉起来 ---");
audio.paused = true;
sandbox.syncAmbientAudio();
await tick();
chk("暂停状态下重新 play()", audio.playCount, 3);
chk("暂停状态下淡入", sandbox.fadeCalls.length, 3);

console.log("\n--- 静音时不播放，但保持音量归零 ---");
sandbox = buildSandbox({ id: "water-ambient", src: "assets/sounds/water-ambient.mp3", muted: true });
sandbox.syncAmbientAudio();
await tick();
audio = sandbox.getWaterAudio();
chk("静音时仍然建好播放器", audio instanceof FakeAudio, true);
chk("静音时不 play()", audio.playCount, 0);
chk("静音时音量为 0", audio.volume, 0);
chk("静音时不淡入", sandbox.fadeCalls.length, 0);

console.log("\n--- 音源失效时回落到内置音效 ---");
sandbox = buildSandbox({ id: "water-ambient", src: "/uploads/sounds/dead-link.mp3" });
sandbox.syncAmbientAudio();
await tick();
audio = sandbox.getWaterAudio();
chk("先按后台配置加载", audio.src, "/uploads/sounds/dead-link.mp3");
chk("加载失败前已尝试播放", audio.playCount, 1);
// 浏览器拿到 404 时会触发 error 事件
audio.onerror();
await tick();
chk("回落后指向内置文件", audio.src, "assets/sounds/water-ambient.mp3");
chk("回落后重新加载", audio.loadCount, 1);
chk("回落后继续播放", audio.playCount, 2);
audio.onerror();
await tick();
chk("内置文件也失败时不再反复折腾", audio.playCount, 2);

console.log("\n----");
console.log(`ambient-audio.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
