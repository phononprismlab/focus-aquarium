const now = () => new Date().toISOString();

const seed = {
  decorations: [
    { id: "fish001", category: "fish", name: "小丑鱼", description: "色彩明亮的小丑鱼，为鱼缸增添一点活泼的海洋气息。", previewImage: "", price: 30, resourcePath: "assets/fish/fish001.webp", isMemberOnly: false, maxInventory: 50, tags: [] },
    { id: "fish002", category: "fish", name: "蓝尾鱼", description: "带着蓝色尾鳍的小鱼，游动时看起来清爽又灵巧。", previewImage: "", price: 35, resourcePath: "assets/fish/fish002.webp", isMemberOnly: false, maxInventory: 50, tags: [] },
    { id: "fish003", category: "fish", name: "金色小鱼", description: "闪着金色光泽的小鱼，让鱼缸多一点温暖的亮色。", previewImage: "", price: 45, resourcePath: "assets/fish/fish003.webp", isMemberOnly: true, maxInventory: 50, tags: [] },
    // tags 上的 `undersea-treasure` 是「海底的宝藏」事件的挂钩（S2 / F15）：
    // 事件与资源之间只通过 tag 关联 —— 缸里有带这个 tag 的装扮，事件才可能触发。
    // ⚠️ 没有任何资源带它时，treasure 会**静默地永远不触发**（既不报错也不给泡泡）。
    // 换挂到别的装扮上不用改代码，后台改 tags 字段即可。
    { id: "decoration001", category: "decorations", name: "水草", description: "柔软舒展的基础水草，适合打造自然的鱼缸底景。", previewImage: "", price: 20, resourcePath: "assets/plants/plant001.webp", isMemberOnly: false, maxInventory: 1, tags: ["undersea-treasure"] },
    { id: "decoration002", category: "decorations", name: "细叶水草", description: "细长挺拔的水草，让鱼缸拥有更丰富的层次。", previewImage: "", price: 30, resourcePath: "assets/plants/plant002.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "decoration003", category: "decorations", name: "红色水草", description: "带有红色叶片的水草，为鱼缸加入一抹醒目的颜色。", previewImage: "", price: 50, resourcePath: "assets/plants/plant003.webp", isMemberOnly: true, maxInventory: 1, tags: [] },
    { id: "background001", category: "backgrounds", name: "浅海晨光", description: "明亮柔和的浅海背景。", previewImage: "", price: 30, resourcePath: "assets/backgrounds/background001.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "background002", category: "backgrounds", name: "深海夜色", description: "深沉安静的海底夜色。", previewImage: "", price: 60, resourcePath: "assets/backgrounds/background002.webp", isMemberOnly: true, maxInventory: 1, tags: [] },
    { id: "background003", category: "backgrounds", name: "珊瑚黄昏", description: "带着珊瑚色调的黄昏海景。", previewImage: "", price: 50, resourcePath: "assets/background003.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sand001", category: "sands", name: "暖色细沙", description: "温暖细腻的浅色沙地。", previewImage: "", price: 20, resourcePath: "assets/sands/sand001.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sand002", category: "sands", name: "深海黑沙", description: "沉静的深色沙地。", previewImage: "", price: 35, resourcePath: "assets/sands/sand002.webp", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sound001", category: "sounds", name: "海水白噪音", description: "轻柔的水下环境声。", previewImage: "", price: 25, resourcePath: "assets/sounds/sound001.mp3", isMemberOnly: false, maxInventory: 1, tags: [] },
    { id: "sound002", category: "sounds", name: "轻柔气泡声", description: "细碎轻盈的气泡声。", previewImage: "", price: 40, resourcePath: "assets/sounds/sound002.mp3", isMemberOnly: true, maxInventory: 1, tags: [] }
  ],
  fish: [
    { fishid: "fish001", name: "小丑鱼", resourcePath: "assets/fish/clownfish.png", movementCode: "gentle-swim", scaleMin: 0.8, scaleMax: 1.1, feedReaction: true, tags: [] },
    { fishid: "fish002", name: "蓝尾鱼", resourcePath: "assets/fish/blue-tang.png", movementCode: "quick-swim", scaleMin: 0.7, scaleMax: 1.0, feedReaction: true, tags: [] }
  ],
  // 随机事件（F6）：**全部走配置，不写代码**（用户 2026-09-23 决定）。
  // 事件与资源之间只通过 relatedTag / conditions.hasTag 关联，新增资源只要打上 tag 就能被事件用上，
  // 不需要改事件本身，也不需要改前端（F15）。
  //
  // 字段说明：
  //   eventType            online=在线检测 / offline=再次进入时按离线时长结算（F11）
  //   handler              内置 handler 名，见 index.html 的 EVENT_HANDLERS（F12）
  //   params               handler 参数（数量区间、存活时长…）
  //   relatedTag           关联的资源 tag（S2）——文案里的 {source} 就是命中的资源名
  //   probability          单次检测命中率（S8：不是「每分钟」也不是「每次专注」）
  //   checkIntervalSeconds 在线检测间隔（S8）
  //   cooldownMinutes      同一事件冷却（S8）
  //   maxPerDay            每日上限（S8）
  //   message              叙事文案，支持 {count} {name} {source} 占位符
  //   conditions           触发前置条件（F8，结构化规则，不是代码）
  events: [
    {
      id: "give-bubbles",
      name: "意外的礼物",
      description: "小鱼在缸里翻出了一小捧泡泡。",
      enabled: true,
      eventType: "online",
      handler: "give-bubbles",
      params: { min: 5, max: 15 },
      relatedTag: "",
      probability: 0.03,
      checkIntervalSeconds: 60,
      cooldownMinutes: 30,
      maxPerDay: 3,
      message: "小鱼在缸里翻出了一小捧泡泡，{count} 颗泡泡落进了你的口袋。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "" }
    },
    {
      id: "treasure",
      name: "海底的宝藏",
      description: "小鱼在带 undersea-treasure 标签的装扮里发现了泡泡。",
      enabled: true,
      eventType: "online",
      handler: "treasure",
      params: { min: 15, max: 40 },
      relatedTag: "undersea-treasure",
      probability: 0.02,
      checkIntervalSeconds: 120,
      cooldownMinutes: 120,
      maxPerDay: 2,
      message: "小鱼钻进{source}里，叼出了 {count} 颗泡泡。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "undersea-treasure" }
    },
    {
      id: "fish-escape",
      name: "小鱼跳出了鱼缸",
      description: "某条鱼顺着水流跳出了鱼缸。想它的话，可以再去商店接一条回来。",
      enabled: true,
      eventType: "online",
      handler: "fish-escape",
      // 经济循环的消耗端（S6）：鱼会真的走，但可回购。
      // minSurvivalMinutes：刚买不久的鱼不参与，避免「刚买就跳」的挫败感。
      params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 },
      relatedTag: "",
      probability: 0.01,
      checkIntervalSeconds: 300,
      cooldownMinutes: 720,
      maxPerDay: 1,
      message: "{name} 顺着水流跳出了鱼缸。想它的话，可以再去商店接一条回来。",
      // minFish 至少 2：不让最后一条鱼也走掉，避免留下一个空缸。
      conditions: { minFish: 2, minBubbles: 0, hasTag: "" }
    },
    {
      id: "welcome-back",
      name: "久别重逢",
      description: "离开一段时间后回来，小鱼攒了一点泡泡。",
      enabled: true,
      // offline：不是定时检测，而是**再次进入时**按离线时长结算（F11）。
      eventType: "offline",
      handler: "give-bubbles",
      // maxOfflineHours：单次离线时长上限，防挂机刷（S7）。挂一天和挂一周结果一样。
      params: { min: 8, max: 24, maxOfflineHours: 24 },
      relatedTag: "",
      // probability 在这里是「**每小时**离线的命中率」：离线越久越可能触发，封顶 1。
      probability: 0.3,
      // 离线事件不使用检测间隔，这一项只为了满足配置形状（服务端对 offline 不强制校验）。
      checkIntervalSeconds: 60,
      cooldownMinutes: 480,
      maxPerDay: 1,
      message: "好久没来了。小鱼攒了 {count} 颗泡泡，都给你。",
      conditions: { minFish: 1, minBubbles: 0, hasTag: "" }
    }
  ],
  focus: {
    minFocusDuration: 25,
    maxFocusDuration: 120,
    rewardTiers: [
      { id: "tier-1", endMinute: 25, normalBubblePerMinute: 1, memberBubblePerMinute: 2 },
      { id: "tier-2", endMinute: 60, normalBubblePerMinute: 2, memberBubblePerMinute: 3 },
      { id: "tier-3", endMinute: 120, normalBubblePerMinute: 3, memberBubblePerMinute: 5 }
    ]
  },
  audio: {
    categories: {
      bgm: { label: "背景白噪音", enabled: true, volume: 38 },
      prompt: { label: "提示音", enabled: true, volume: 100 },
      sfx: { label: "交互音效", enabled: true, volume: 100 }
    },
    sounds: [
      { id: "water-ambient", name: "海水白噪音", category: "bgm", enabled: true, volume: 100, resourcePath: "assets/sounds/water-ambient.mp3", loop: true },
      { id: "focus-start", name: "开始专注", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "focus-complete", name: "专注完成", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "feed", name: "投喂饲料", category: "sfx", enabled: true, volume: 100, resourcePath: "" },
      { id: "fish-startle", name: "鱼儿受惊", category: "sfx", enabled: true, volume: 100, resourcePath: "" }
    ]
  },
  // 「关于」区块内容（设置抽屉里跳出来的用户协议 / 隐私政策 / 品牌故事 / 打赏 / 备案）。
  // 做成后台可配置：玩家端拉 /api/game/about 的已发布版本渲染，后台改完点发布才生效。
  // 单例配置（和 focus / audio 同构）：整段是一个对象，5 个固定 section。
  //   title    弹窗标题（后台可改）
  //   bodyHtml 正文（允许 HTML；后台自己填，风险自负）
  //   imageUrl 仅 tip 用：打赏二维码图片地址，玩家端自动拼 <img>
  about: {
    // ⚠️ 与 index.html 的 ABOUT_FALLBACK 保持一致；改一处必须改另一处。
    terms:  { title: "用户协议", bodyHtml: `
<p><strong>版本 V1.0</strong>　<strong>生效日期</strong> 2026 年 10 月 5 日　<strong>运营主体</strong> 杭州棱镜映画创意设计工作室（个人独资）</p>

<h4>一、协议的适用与接受</h4>
<p>本协议是你与杭州棱镜映画创意设计工作室（个人独资）（以下称"我们"）就使用"鱼儿乐水族"所订立的协议。本服务当前通过 【待填：服务域名】 提供。</p>
<p>当你首次打开本服务页面并开始使用，即视为你已阅读并同意本协议全部内容。若你不同意，请停止使用。</p>
<p>若你未满 14 周岁，请在监护人陪同下阅读本协议与《隐私政策》，并在监护人同意后使用。</p>

<h4>二、我们提供什么</h4>
<p>本服务是一个专注辅助工具：以番茄钟计时为核心，配合虚拟鱼缸养成的轻量反馈。你设定一段专注时长，专注期间离开或中断会影响本次结算；完成后获得虚拟货币"泡泡"，用于在应用内购买鱼、装饰等虚拟内容。</p>
<p>我们明确承诺：本服务不设计签到连胜、排行榜、每日打卡催促等制造焦虑的机制。你可以随时开始、随时停止，不完成不会产生任何现实后果。</p>
<p>本服务为工具属性，不构成医疗、心理咨询或专业时间管理建议。</p>

<h4>三、账号</h4>
<ul>
<li><strong>匿名账号，无需注册。</strong>首次使用时，服务端会为你的浏览器自动生成一个随机账号标识。我们不要求你提供手机号、邮箱、密码或任何身份证明。</li>
<li><strong>账号存在本地。</strong>账号凭证保存在你当前浏览器的本地存储中。清除浏览器数据、更换浏览器或使用无痕模式，都会导致账号凭证丢失，从而无法再访问原账号。</li>
<li><strong>换设备用同步码迁移。</strong>你可以在设置中生成一次性"同步码"（有效期 10 分钟），在新设备输入该码即可把账号与鱼缸迁移过去。同步码等同于账号凭证，请勿发送给他人；我们只会留存同步码的哈希值，无法还原或找回它。</li>
<li><strong>账号免费、一号一用。</strong>请勿将账号出借、转让或与他人共用。</li>
</ul>

<h4>四、虚拟内容</h4>
<ul>
<li>泡泡、鱼、装饰、背景、音效等均为应用内虚拟内容，仅在本服务内使用。</li>
<li>虚拟内容不具有任何现实货币价值，不可兑换为现金或实物，不可转让、交易、赠与，不因你停止使用而产生任何退款或补偿。</li>
<li>我们有权调整虚拟内容的获取方式、价格与可获得性；调整不影响你已经获得的虚拟内容继续使用。</li>
<li>泡泡余额以服务端记录为准。如出现异常数据（如通过篡改本地数据、伪造接口请求等方式获取），服务端会拒绝该次变更，我们也有权对相应账号采取重置、限制或停止服务的措施。</li>
<li>因设备故障、浏览器数据被清除、同步码丢失等自身原因造成的虚拟内容损失，我们不承担责任。</li>
</ul>

<h4>五、会员与支持者</h4>
<p>本服务目前未接入任何支付渠道，不向你收取费用，也不存在自动续费。</p>
<p>"支持者"等身份标记目前由我们人工授予，不构成你与我们之间的买卖关系，不对应任何付费权益承诺。若未来开通付费功能，我们会另行公示并重新取得你的同意。</p>

<h4>六、你的使用规范</h4>
<p>使用本服务时，你不得从事下列行为：</p>
<ul>
<li>通过脚本、自动化程序、伪造请求等方式刷取泡泡、虚拟内容或干扰服务正常运行；</li>
<li>对服务进行反向工程、反编译，或提取、复制、二次分发我们的美术素材、音频、代码与设计；</li>
<li>攻击、扫描、压测我们的服务器或接口，或规避我们的访问频率限制；</li>
<li>利用本服务从事任何违法违规活动；</li>
<li>其他损害我们或他人合法权益的行为。</li>
</ul>
<p>违反上述约定的，我们有权在不事先通知的情况下，对该账号采取限制功能、重置数据或停止服务的措施。</p>

<h4>七、知识产权</h4>
<ul>
<li>本服务的程序代码、界面设计、插画、音频、文案及整体编排，其著作权及其他知识产权均归我们所有。其中的插画与美术素材为原创作品。</li>
<li>你在使用本服务过程中产生的数据（如专注记录、鱼缸布置）归你所有；但你在应用内的操作不构成对我们任何权利的转让或许可。</li>
<li>未经我们书面许可，你不得将本服务的任何素材用于商业用途，或搬运至其他平台发布。</li>
</ul>

<h4>八、服务的中断、变更与终止</h4>
<ul>
<li>我们可能因服务器维护、故障、不可抗力或政策要求而暂时中断服务。需要计划内停机维护时，我们会尽量通过应用内公告提前告知。</li>
<li>我们保留调整、升级或下线部分功能的权利。功能调整不影响你已经获得的虚拟内容的既有使用。</li>
<li>如我们决定终止运营本服务，将尽合理努力提前公告，并为你提供导出个人数据的途径。</li>
<li>你可以随时停止使用本服务，并可按《隐私政策》要求删除你的数据。</li>
</ul>

<h4>九、免责声明</h4>
<ul>
<li>本服务按"现状"提供。我们尽合理努力保障其可用与安全，但不保证服务永不中断、永不出错。</li>
<li>因网络故障、设备故障、操作系统或浏览器差异、第三方平台限制等非我们可控原因导致的损失，我们不承担责任。</li>
<li>在法律允许的最大范围内，我们对你使用本服务所产生间接损失的赔偿责任，不超过你因使用本服务向我们支付的费用总额；本服务目前免费，故该上限为零。</li>
</ul>

<h4>十、未成年人使用</h4>
<ul>
<li>本服务不面向儿童进行定向内容推送或行为诱导，不投放广告。</li>
<li>未满 14 周岁的用户，应在监护人陪同与同意下使用，并由监护人协助管理使用时长。</li>
<li>我们不会明知而收集儿童的个人信息。监护人如发现被监护人向我们提供了个人信息，可通过《隐私政策》所列联系方式要求删除。</li>
</ul>

<h4>十一、协议变更与法律适用</h4>
<ul>
<li>本协议如有修改，我们会在应用内或页面上公示。继续使用即视为接受修改后的协议；若你不同意，可停止使用并要求删除数据。</li>
<li>本协议适用中华人民共和国大陆地区法律（不含冲突法）。</li>
<li>因本协议产生的争议，双方应先友好协商；协商不成的，任何一方均可向运营主体所在地（浙江省杭州市）有管辖权的人民法院提起诉讼。</li>
</ul>

<h4>十二、联系我们</h4>
<p>对本协议有任何疑问，请通过 【待填：联系邮箱】 与我们联系。</p>
` },
    privacy:{ title: "隐私政策", bodyHtml: `
<p><strong>一句话版：</strong>我们不用手机号、不用邮箱、不要实名，账号是自动生成的匿名 ID；你填的昵称是你唯一能写的个人信息，且随时可清空。我们不接第三方统计、不投广告、不卖数据。</p>

<h4>一、我们收集哪些信息</h4>
<ul>
<li><strong>账号标识</strong>：服务端自动生成的随机 ID、创建时间、最近活跃时间。用途：识别你的账号、跨设备同步。</li>
<li><strong>昵称</strong>：你在「我的」中自行填写，最多 12 个字符。自愿填写、可留空。用途：个人资料展示。</li>
<li><strong>游戏存档</strong>：泡泡余额、已获得的鱼与装饰、鱼缸布置、应用设置。用途：保存并同步你的进度。</li>
<li><strong>专注记录</strong>：计划时长、计入时长、开始与结算时间、是否自然走完。用途：结算泡泡奖励、统计你的专注数据。</li>
<li><strong>使用事件</strong>：打开应用、开始专注、完成专注、应用内购买。用途：了解功能使用情况、改进产品。</li>
<li><strong>支持者标记</strong>：是否支持者、备注。人工授予。用途：区分功能可见范围。</li>
<li><strong>同步码</strong>：换设备迁移用，仅保存哈希值，10 分钟后失效。</li>
<li><strong>网络地址（IP）</strong>：仅用于接口访问频率限制（防刷），不落库、不用于用户画像。</li>
</ul>
<p>关于专注记录：这是本服务的核心数据，我们仅在为你呈现统计与结算奖励时使用，不会对外披露、不会与第三方共享你的个人专注明细。</p>

<h4>二、我们不收集什么</h4>
<ul>
<li>不收集手机号、邮箱、密码；</li>
<li>不收集真实姓名、身份证号、人脸等身份识别信息；</li>
<li>不收集通讯录、短信、通话记录；</li>
<li>不收集精确位置或位置轨迹；</li>
<li>不访问相册、麦克风、摄像头；</li>
<li>不读取你的其他网站数据或跨站追踪；</li>
<li>不使用 Cookie 做广告定向，不接入任何第三方统计、广告或数据分析服务；</li>
<li>不接入支付，因此不收集任何支付或银行卡信息。</li>
</ul>

<h4>三、本地存储</h4>
<p>以下内容保存在你自己的浏览器本地存储中，不会主动上传，清除浏览器数据即消失：账号登录凭证、你的游戏存档副本（用于离线使用与断网续玩）、应用设置（音效开关、音量等）、公告已读标记。</p>
<p>注意：本地存档是副本。当你联网时，服务端记录为最终版本；若本地副本与服务端记录冲突，以服务端为准。</p>

<h4>四、我们如何使用信息</h4>
<ul>
<li>为你保存、同步并恢复游戏进度；</li>
<li>结算专注奖励与统计你的专注数据；</li>
<li>保障服务安全：识别并拦截异常请求、限制访问频率；</li>
<li>了解功能使用情况，以决定后续改什么、不做什么；</li>
<li>向你推送应用内公告（如停机维护通知）。</li>
</ul>

<h4>五、信息的存储、共享与转让</h4>
<ul>
<li><strong>存储地点</strong>：你的数据存储于境内云计算服务商的数据库中，传输过程使用 HTTPS 加密。</li>
<li><strong>不共享、不出售</strong>：我们不会向任何第三方出售、出租或共享你的个人信息。</li>
<li><strong>例外情形</strong>仅有两类：依据法律法规、监管机构或司法机关的强制性要求；为维护服务安全所必需的技术处理，此类处理方不得将数据用于其他目的。</li>
<li>若未来发生主体变更、合并或业务转让，我们会告知你并要求接收方继续受本政策约束，否则将重新征求你的同意。</li>
</ul>

<h4>六、保留期限</h4>
<ul>
<li>你的账号与存档数据：在你持续使用期间保留。</li>
<li>你主动要求删除，或长期（连续 24 个月）未活跃且我们决定清理时，我们会删除或匿名化处理相关数据。</li>
<li>法律法规要求更长保留期限的，按规定执行。</li>
</ul>

<h4>七、你的权利</h4>
<ul>
<li><strong>查看</strong>：应用内「我的」页面可查看昵称、注册时间、鱼数、累计专注。</li>
<li><strong>更正</strong>：应用内「我的」直接修改昵称。</li>
<li><strong>清空个人信息</strong>：应用内把昵称清空并保存，即删除该字段。</li>
<li><strong>导出</strong>：通过 【待填：联系邮箱】 向我们索取你的数据副本。</li>
<li><strong>删除账号与全部数据</strong>：发邮件至 【待填：联系邮箱】，我们在 【待填：注销处理时限】 内处理并回复确认。</li>
</ul>
<p>我们会在核实你的账号归属后处理上述请求。删除后数据不可恢复，请谨慎决定。</p>

<h4>八、未成年人信息保护</h4>
<ul>
<li>我们不在明知的情况下收集未满 14 周岁儿童的个人信息。</li>
<li>若你是未成年人的监护人，发现被监护人向我们提供了个人信息，请通过第十条联系方式联系我们，我们会尽快删除。</li>
<li>本服务不向未成年人投放广告，也不做基于个人信息的自动化决策或个性化推荐。</li>
</ul>

<h4>九、政策更新</h4>
<p>本政策如有修改，我们会在应用内或页面上公示更新后的版本与生效日期。若涉及收集范围、使用目的或共享对象的实质性变更，我们会以更显著的方式提示，并在法律要求时重新取得你的同意。</p>

<h4>十、联系我们</h4>
<p>对个人信息处理有任何疑问、投诉或请求，请通过 【待填：联系邮箱】 与我们联系，我们会在合理期限内答复。</p>
` },
    story:  { title: "品牌故事", bodyHtml: "<p>品牌故事内容待补充。</p><p>这是鱼儿乐水族的由来 —— 爸妈以前开过水族馆，店没了鱼也少了，想把那些鱼「留在网上」。</p>" },
    tip:    { title: "打赏支持", bodyHtml: "<p>如果鱼儿乐水族让你感到放松，欢迎请我喝杯咖啡。</p>", imageUrl: "" },
    // 主体在杭州（浙江）→ 备案号前缀是「浙ICP备」，不是「沪」。备案通过后回填真实号。
    filing: { title: "备案信息", bodyHtml: "<p>备案号：浙ICP备XXXXXX号（ICP 备案通过后回填）</p><p>公安联网备案号：待补充</p>" }
  },
  // 运营配置：停机 + 通知。
  // 停机是**服务端闸门** —— maintenance 为真时玩家写接口一律 503，
  // 只有 maintenanceAllowUids 里的 uid 能继续写（开发者自己在维护窗口里验证用）。
  // 白名单放在服务端配置里，玩家改 URL 参数绕不过去。
  // 🔴 运营态单例：seed 只给初始结构，之后以后台编辑的值为准（见 applySeedDefault）。
  //    按普通单例那样「每次启动以 seed 为准」的话，maintenance 会被冲回 false，
  //    维护窗口里服务一重启停机就失效了 —— 那才是最危险的时刻。
  ops: {
    maintenance: false,
    maintenanceMessage: "",
    maintenanceEta: "",
    maintenanceAllowUids: [],
    notice: {
      id: "",
      level: "info",
      title: "",
      body: "",
      startAt: 0,
      endAt: 0,
      ctaText: "",
      ctaUrl: "",
      active: false
    }
  }
};

const singletonTypes = new Set(["focus", "audio", "about", "ops"]);
// 运营态单例：后台填的值必须**跨重启保留**（停机开关、通知文案、白名单），
// 所以 seed 只负责给初始结构、补齐以后新增的字段，绝不覆盖已有值。
const operationalSingletons = new Set(["ops"]);
const idForType = (type, data) => type === "fish" ? data.fishid : singletonTypes.has(type) ? type : data.id;

function makeRecord(type, data, published = true) {
  return { type, id: idForType(type, data), data, publishedData: published ? structuredClone(data) : null, published, updatedAt: now() };
}

// ===== 种子数据迁移（B2）=====
// 旧逻辑只在行不存在时 insert，已存在的行永不更新 —— 导致「新增默认项 / 改默认参数 / 加新字段」
// 无法下发到已部署环境（老用户永远看到旧默认集）。
// 现在改为：启动时按 seed 合并，保证默认集持续一致，且**绝不覆盖用户已改过的内容**。

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// B15：种子历史上写过一批**并不存在**的 previewImage 假路径（assets/xxx/yyy_preview.webp）。
// 这些文件从未上传过，留在配置里只会在商店里各打一次 404。老库若还是这些值，视为「未设置」清掉，
// 让 seed 的空值生效。后台上传的图落在 images/ 且文件名带时间戳+uuid，不会命中这个形状。
const LEGACY_PLACEHOLDER_PREVIEW = /^assets\/[\w-]+\/[\w-]+_preview\.(webp|png|jpe?g|gif|avif)$/i;
export function isLegacyPlaceholderPreview(value) {
  return typeof value === "string" && LEGACY_PLACEHOLDER_PREVIEW.test(value.trim());
}

// 把 seed 默认值应用到某条已存储记录，返回「应当写入的数据」。
// - 单例配置（focus / audio）：直接以最新 seed 为准（应用配置更新应随版本生效）。
// - 用户内容（decorations / fish）：以 seed 为基底，仅补齐缺失字段，保留用户已有值。
export function applySeedDefault(type, stored, seed) {
  const base = structuredClone(seed);
  if (singletonTypes.has(type)) {
    // 运营态单例（ops）：以 stored 为准，只把 seed 里新增的字段补进去。
    // 停机状态要是重启就没了，维护窗口等于裸奔。
    if (operationalSingletons.has(type) && stored && typeof stored === "object" && Object.keys(stored).length) {
      const merged = { ...base, ...stored };
      if (base.notice || stored.notice) merged.notice = { ...(base.notice || {}), ...(stored.notice || {}) };
      return merged;
    }
    return base;
  }
  const merged = base;
  for (const [k, v] of Object.entries(stored || {})) {
    if (v === null || v === undefined) continue;
    // B15：老库里的假预览图路径不算「用户填过的值」，丢掉让 seed 的空值生效。
    if (k === "previewImage" && isLegacyPlaceholderPreview(v)) continue;
    merged[k] = v;
  }
  return merged;
}

// 纯函数：规划某 type 的 seed 迁移操作（不触碰数据库），供云端仓库复用与单测。
// existingRows 形状：{ id, data, publishedData, rowId }
export function planSeedMigration(type, seedValues, existingRows) {
  const existingById = new Map(existingRows.map(r => [r.id, r]));
  return seedValues.map(seed => {
    const id = idForType(type, seed);
    const existing = existingById.get(id);
    if (!existing) {
      return { action: "insert", id, data: structuredClone(seed) };
    }
    const newData = applySeedDefault(type, existing.data, seed);
    const newPublished = existing.publishedData != null
      ? applySeedDefault(type, existing.publishedData, seed)
      : newData;
    const changed = !deepEqual(newData, existing.data) || !deepEqual(newPublished, existing.publishedData);
    if (!changed) return { action: "skip", id };
    return { action: "update", id, data: newData, publishedData: newPublished, rowId: existing.rowId };
  });
}

export function createMemoryRepository() {
  const records = new Map();
  Object.entries(seed).forEach(([type, value]) => {
    const values = Array.isArray(value) ? value : [value];
    values.forEach(data => {
      const record = makeRecord(type, structuredClone(data));
      records.set(`${type}:${record.id}`, record);
    });
  });

  return {
    async list(type, publishedOnly = false) {
      return [...records.values()].filter(record => record.type === type && (!publishedOnly || record.published)).map(record => structuredClone(record));
    },
    async save(type, id, data) {
      const key = `${type}:${id}`;
      const current = records.get(key);
      const record = current ? {
        ...current,
        data: structuredClone(data),
        published: false,
        updatedAt: now()
      } : makeRecord(type, structuredClone(data), false);
      records.set(key, record);
      return structuredClone(record);
    },
    async remove(type, id) {
      records.delete(`${type}:${id}`);
    },
    async publish(type, id) {
      const record = records.get(`${type}:${id}`);
      if (!record) return null;
      record.published = true;
      record.publishedData = structuredClone(record.data);
      record.updatedAt = now();
      return structuredClone(record);
    }
  };
}

// RDB 客户端单例。配置仓库与玩家数据层（player-store.js）共用同一个实例 ——
// 两边各 init 一次会得到两个互不相干的客户端，各带一份连接与鉴权状态，
// 没有任何好处，只是白白多一份开销。
let rdbInstance = null;
let rdbPromise = null;
export async function getRdb() {
  if (rdbInstance) return rdbInstance;
  if (!rdbPromise) {
    rdbPromise = (async () => {
      const { default: cloudbase } = await import("@cloudbase/js-sdk");
      const app = cloudbase.init({
        env: process.env.CLOUDBASE_ENV_ID,
        accessKey: process.env.CLOUDBASE_APIKEY
      });
      rdbInstance = app.rdb();
      return rdbInstance;
    })();
    // 初始化失败时清掉缓存的 promise：否则后续每次调用都会拿到同一个 rejected promise，
    // 一次网络抖动就会让进程内再也建不出客户端。
    rdbPromise.catch(() => { rdbPromise = null; });
  }
  return rdbPromise;
}

// 仅供测试：注入替身，或重置单例。
export function setRdbForTest(instance) {
  rdbInstance = instance;
  rdbPromise = instance ? Promise.resolve(instance) : null;
}

export async function createCloudbaseRepository() {
  const db = await getRdb();
  const tableName = "fishtank_configs";

  // 种子迁移：把 seed 的默认集合并进已部署的数据库（B2）。
  // 一次性按 type 拉取全部已存在行，与 seed 比对后规划 insert / update / skip，
  // 缺失的新项与缺失字段会被补齐，用户已改过的内容不会被覆盖。
  for (const [type, value] of Object.entries(seed)) {
    const seedValues = Array.isArray(value) ? value : [value];
    const { data: rows } = await db.from(tableName).select("*").eq("type", type).throwOnError();
    // 防御：数据层异常时 select 可能返回非数组（测试用的假环境就会这样），
    // 归一化成数组，避免 .map 直接把整个仓库初始化搞崩。真实环境正常返回数组。
    const existingRows = Array.isArray(rows) ? rows : [];
    const plan = planSeedMigration(type, seedValues, existingRows.map(r => ({
      id: r.config_id,
      data: r.data || {},
      publishedData: r.published_data,
      rowId: r.id
    })));
    for (const op of plan) {
      if (op.action === "insert") {
        await db.from(tableName).insert([{
          type,
          config_id: op.id,
          data: op.data,
          published_data: structuredClone(op.data),
          published: true,
          updated_at: now()
        }], { defaultToNull: false }).throwOnError();
      } else if (op.action === "update") {
        await db.from(tableName).update({
          data: op.data,
          published_data: op.publishedData ?? op.data,
          updated_at: now()
        }).eq("id", op.rowId).throwOnError();
      }
    }
  }

  const toRecord = row => ({
    type: row.type,
    id: row.config_id,
    data: row.data,
    publishedData: row.published_data || null,
    published: row.published === true,
    updatedAt: row.updated_at
  });
  return {
    async list(type, publishedOnly = false) {
      let query = db.from(tableName).select("*").eq("type", type);
      if (publishedOnly) query = query.eq("published", true);
      const { data } = await query.throwOnError();
      return data.map(toRecord);
    },
    async save(type, id, data) {
      const { data: existing } = await db
        .from(tableName)
        .select("*")
        .eq("type", type)
        .eq("config_id", id)
        .limit(1)
        .throwOnError();
      const current = existing[0];
      const row = {
        type,
        config_id: id,
        data,
        published_data: current?.published_data || (current?.published ? current.data : null),
        published: false,
        updated_at: now()
      };
      if (current) {
        await db.from(tableName).update(row).eq("id", current.id).throwOnError();
      } else {
        await db.from(tableName).insert([row], { defaultToNull: false }).throwOnError();
      }
      return toRecord({ ...row, id: current?.id });
    },
    async remove(type, id) {
      const { data: existing } = await db
        .from(tableName)
        .select("id")
        .eq("type", type)
        .eq("config_id", id)
        .throwOnError();
      await Promise.all(existing.map(row => db.from(tableName).delete().eq("id", row.id).throwOnError()));
    },
    async publish(type, id) {
      const { data: existing } = await db
        .from(tableName)
        .select("*")
        .eq("type", type)
        .eq("config_id", id)
        .limit(1)
        .throwOnError();
      const current = existing[0];
      if (!current) return null;
      const updatedAt = now();
      await db.from(tableName).update({
        published: true,
        published_data: current.data,
        updated_at: updatedAt
      }).eq("id", current.id).throwOnError();
      return { type, id, data: current.data, publishedData: current.data, published: true, updatedAt };
    }
  };
}

export async function createRepository() {
  if (process.env.CLOUDBASE_ENV_ID) return createCloudbaseRepository();
  if (process.env.NODE_ENV === "production") throw new Error("CLOUDBASE_ENV_ID is required in production");
  return createMemoryRepository();
}
