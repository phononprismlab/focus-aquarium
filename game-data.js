// 内置默认数据：仅在配置接口不可用时兜底，正常情况下后台下发的配置会覆盖它。
// 后台是唯一权威数据源；这里的内容只用于离线可玩和首次启动。
window.FISHTANK_DEFAULT_DATA = {
  shopItems: [
    { id:"fish001", category:"fish", name:"小丑鱼", description:"色彩明亮的小丑鱼，为鱼缸增添一点活泼的海洋气息。", previewImage:"assets/fish/fish001_preview.webp", price:30, resourcePath:"assets/fish/fish001.webp", isMemberOnly:false, maxInventory:50 },
    { id:"fish002", category:"fish", name:"蓝尾鱼", description:"带着蓝色尾鳍的小鱼，游动时看起来清爽又灵巧。", previewImage:"assets/fish/fish002_preview.webp", price:35, resourcePath:"assets/fish/fish002.webp", isMemberOnly:false, maxInventory:50 },
    { id:"fish003", category:"fish", name:"金色小鱼", description:"闪着金色光泽的小鱼，让鱼缸多一点温暖的亮色。", previewImage:"assets/fish/fish003_preview.webp", price:45, resourcePath:"assets/fish/fish003.webp", isMemberOnly:true, maxInventory:50 },

    { id:"decoration001", category:"decorations", name:"水草", description:"柔软舒展的基础水草，适合打造自然的鱼缸底景。", previewImage:"assets/plants/plant001_preview.webp", price:20, resourcePath:"assets/plants/plant001.webp", isMemberOnly:false, maxInventory:1 },
    { id:"decoration002", category:"decorations", name:"细叶水草", description:"细长挺拔的水草，让鱼缸拥有更丰富的层次。", previewImage:"assets/plants/plant002_preview.webp", price:30, resourcePath:"assets/plants/plant002.webp", isMemberOnly:false, maxInventory:1 },
    { id:"decoration003", category:"decorations", name:"红色水草", description:"带有红色叶片的水草，为水下景色加入一抹醒目的颜色。", previewImage:"assets/plants/plant003_preview.webp", price:50, resourcePath:"assets/plants/plant003.webp", isMemberOnly:true, maxInventory:1 },

    { id:"background001", category:"backgrounds", name:"浅海晨光", description:"明亮柔和的浅海背景，像阳光落在清澈的海水里。", previewImage:"assets/backgrounds/background001_preview.webp", price:30, resourcePath:"assets/backgrounds/background001.webp", isMemberOnly:false, maxInventory:1 },
    { id:"background002", category:"backgrounds", name:"深海夜色", description:"深沉安静的海底夜色，适合营造宁静的晚间氛围。", previewImage:"assets/backgrounds/background002_preview.webp", price:60, resourcePath:"assets/backgrounds/background002.webp", isMemberOnly:true, maxInventory:1 },
    { id:"background003", category:"backgrounds", name:"珊瑚黄昏", description:"带着珊瑚色调的黄昏海景，让鱼缸显得温暖而梦幻。", previewImage:"assets/backgrounds/background003_preview.webp", price:50, resourcePath:"assets/backgrounds/background003.webp", isMemberOnly:false, maxInventory:1 },

    { id:"sand001", category:"sands", name:"暖色细沙", description:"温暖细腻的浅色沙地，适合作为基础鱼缸底景。", previewImage:"assets/sands/sand001_preview.webp", price:20, resourcePath:"assets/sands/sand001.webp", isMemberOnly:false, maxInventory:1 },
    { id:"sand002", category:"sands", name:"深海黑沙", description:"沉静的深色沙地，让鱼缸整体显得更加深邃。", previewImage:"assets/sands/sand002_preview.webp", price:35, resourcePath:"assets/sands/sand002.webp", isMemberOnly:false, maxInventory:1 },

    { id:"sound001", category:"sounds", name:"海水白噪音", description:"轻柔的水下环境声，让专注时的鱼缸更加安静。", previewImage:"assets/sounds/sound001_preview.webp", price:25, resourcePath:"assets/sounds/sound001.mp3", isMemberOnly:false, maxInventory:1 },
    { id:"sound002", category:"sounds", name:"轻柔气泡声", description:"细碎轻盈的气泡声，为专注时光增加一点流动感。", previewImage:"assets/sounds/sound002_preview.webp", price:40, resourcePath:"assets/sounds/sound002.mp3", isMemberOnly:true, maxInventory:1 }
  ],

  initialAquarium: {
    background:"background001",
    sand:"sand001",
    decoration:"decoration001",
    fish:[
      {instanceId:"initial_fish_001",itemId:"fish001",x:200,y:200},
      {instanceId:"initial_fish_002",itemId:"fish001",x:400,y:300},
      {instanceId:"initial_fish_003",itemId:"fish001",x:300,y:400}
    ],
    ambientSound:"sound001"
  },

  initialInventory: {
    fish:{fish001:3},
    decorations:{decoration001:1},
    backgrounds:{background001:1},
    sands:{sand001:1},
    sounds:{sound001:1}
  },

  focusConfig: {
    minFocusDuration: 25,
    maxFocusDuration: 120,
    rewardTiers: [
      { id:"tier-1", endMinute:25, normalBubblePerMinute:1, memberBubblePerMinute:2 },
      { id:"tier-2", endMinute:60, normalBubblePerMinute:2, memberBubblePerMinute:3 },
      { id:"tier-3", endMinute:120, normalBubblePerMinute:3, memberBubblePerMinute:5 }
    ]
  },

  // 鱼种装配：与 API 侧 seed 保持一致，仅在配置接口不可用时兜底。
  fishAssembly: [
    { fishid:"fish001", name:"小丑鱼", resourcePath:"assets/fish/clownfish.png", movementCode:"gentle-swim", scaleMin:0.8, scaleMax:1.1, feedReaction:true },
    { fishid:"fish002", name:"蓝尾鱼", resourcePath:"assets/fish/blue-tang.png", movementCode:"quick-swim", scaleMin:0.7, scaleMax:1.0, feedReaction:true }
  ],

  // 视觉样式表：渲染代码不再按 id 判断，而是查这张表，新增内置资源只改这里。
  // 后台商品自带的 visual 字段优先于表里的值，所以后台新加的资源也能正常显示。
  //   backgrounds / sands  → css：直接作为 CSS background 值
  //   fish                 → class（模型类名）、emoji（商店预览）
  //   decorations          → class（水草类名）、previewClass（商店预览类名）
  visuals: {
    fish: {
      fish001: { class:"fish small", emoji:"🐠" },
      fish002: { class:"fish small aq-blue", emoji:"🐟" },
      fish003: { class:"fish small aq-gold", emoji:"🐠" }
    },
    decorations: {
      decoration001: { class:"aq-plant-green", previewClass:"v02-plant-green" },
      decoration002: { class:"aq-plant-tall", previewClass:"v02-plant-tall" },
      decoration003: { class:"aq-plant-red", previewClass:"v02-plant-red" }
    },
    backgrounds: {
      background001: { css:"linear-gradient(to bottom,#8bcbd9 0%,#9dd4dc 66%,#a9d6ce 100%)", previewClass:"" },
      background002: { css:"linear-gradient(to bottom,#274c68 0%,#427f91 66%,#6d6751 100%)", previewClass:"night" },
      background003: { css:"linear-gradient(to bottom,#f6cfae 0%,#e79c7c 55%,#8d6a7d 100%)", previewClass:"coral" }
    },
    sands: {
      sand001: { css:"radial-gradient(circle at 15% 35%, rgba(151,121,68,.10) 0 1px, transparent 2px),radial-gradient(circle at 72% 65%, rgba(151,121,68,.08) 0 1px, transparent 2px),#dfcb92", previewClass:"" },
      sand002: { css:"#b8a477", previewClass:"dark" }
    }
  },

  // 表里查不到时用它，保证后台新增的未配置商品也能渲染出来。
  defaults: {
    fish: { class:"fish small", emoji:"🐠" },
    decorations: { class:"aq-plant-green", previewClass:"v02-plant-green" },
    backgrounds: { css:"linear-gradient(to bottom,#8bcbd9 0%,#9dd4dc 66%,#a9d6ce 100%)", previewClass:"" },
    sands: { css:"#b8a477", previewClass:"" }
  }
};
