# 玩家信息渲染图查询功能 — 交接方案（NapCat 侧实现）

> 本文档由 mclds-qq-bot 项目的调研讨论产出，功能最终在 **本项目（mclds-napcat-bot）** 实现。
> 日期：2026-09-11

## 一、需求目标

在 QQ 群 / 私聊中，玩家向 NapCat 验证机器人发送指令，机器人自动根据其 **真实 QQ 号** 查询绑定记录，回复对应 MC 玩家的**信息渲染图（PNG 卡片）**。

- 每个 QQ 对应一个玩家：记录文件 `/data/mclds/.verify_bot_data/verify_success.json`（本项目生成）
- 渲染图通过 mclds-admin 内网 API 获取（见下文第三节）
- **普通玩家只能查自己**；未绑定（verify 记录查不到）→ 直接回复「不存在玩家信息」，禁止输出
- **管理员可按 QQ 号查询任意玩家**（仅私聊场景放开，群内统一只能查自己——可按需要调整）

## 二、为什么放在 NapCat 侧（调研结论摘要）

1. **QQ 官方机器人（mclds-qq-bot，v2 API）拿不到真实 QQ 号**。
   官方文档「API 调用指南 · 唯一身份机制」：用户 openid、群 openid、频道 openid 均按 AppID 隔离生成，**无任何 openid → QQ 号反查接口**；私聊/群/频道三场景全部如此（频道早期 author.id 是 QQ 号，平台已迁移）。
2. **NapCat 也拿不到官方 bot 的 openid**（NTQQ 协议 uin/uid 体系与开放平台 openid 完全隔离，官方 API 文档中无任何 openid 相关接口）。
3. 因此官方 bot 方案必须自建「openid→QQ」绑定映射（管理员协助绑定/验证码握手），链路长、体验差。
4. **NapCat 侧天然可见消息发送者的真实 QQ 号**（`sender.user_id`），且本项目已有指令框架与 `verify_success.json` 读写逻辑——身份链最短、零绑定、绝对安全。
5. 用户已知晓并接受 NapCat 稳定性风险（本功能为只读增强，NapCat 崩溃不影响存量数据与其他系统）。

## 三、渲染图 API（mclds-admin，内网）

```
GET http://127.0.0.1:3067/api/player?uuid=<uuid>&width=700
```

- **访问控制**：来源 IP 为内网（127.0.0.1 等）直接放行，无需 token（已实测 200）
- **Query 参数**：`uuid`（必填，玩家 UUID 或昵称，≤64 字符）；`width=700`（皮肤/信息左右布局）；`skin`/`infos`/`collection`（默认全开）；`text-align`（默认 right）
- **成功**：`200 image/png`（PNG 二进制）
- **失败（JSON）**：400 参数错误 / 403 非内网 / **404 玩家不存在** / **503 渲染失败（Puppeteer 异常、页面超时）**
- **性能**：成品图服务端内存缓存 5 分钟（LRU）；并发渲染上限 2（超出排队）；单页渲染超时 15 秒 → **HTTP 请求超时建议设 20~25 秒**

## 四、verify_success.json 数据结构

```json
{
  "records": [
    {
      "qq": "374762628",
      "uuid": "15dbfda0-5d8b-4849-afe7-4e5d570fd72d",
      "time": "2025/6/29 11:57:03",
      "names": ["yanxiaoxi"],
      "ips": [{ "ip": "...", "time": 1.78e12 }]
    }
  ]
}
```

- 按 `qq`（字符串）匹配；`uuid` 直接传给渲染 API（最准确，避免昵称改名问题）
- `names` 为曾用名列表，最后一个是最近昵称
- 文件约 268KB，建议按 mtime 做简单缓存，避免每条消息全量读盘（现有指令是每次 readFileSync，沿用也可接受）

## 五、本项目现状（实施入口）

`index.mjs`（约 486 行，node-napcat-ts + NCWebsocket）：

- **指令框架**：`registerCommand(name, args, desc, handler)`，`handler(args, quick_action)`，已有指令：
  `QQ查信息` / `游戏名查信息` / `游戏名搜索信息` / `添加白名单` / `查看白名单`
- **触发与分发逻辑**：先阅读 index.mjs 中消息事件注册与指令解析部分（约 200~300 行），确认指令前缀、群/私聊场景区分、`quick_action` 的回复机制（现有均为纯文本数组）
- **现有可复用配置**：`config.query_limit_seconds = 3`（查询限流）、`config.notify_admin_qq`（管理员 QQ，可做管理员指令鉴权）
- 发送图片需确认 `quick_action` 是否支持消息段；不支持则直接在 handler 内调 `napcat.send_msg` / 对应 API，用 OneBot11 图片段

## 六、新增指令设计

### 1. `我的信息`（所有用户，无参数）

```text
sender.user_id（真实 QQ 号）
  → 在 verify_success.json 的 records 中找 qq 匹配
    → 无记录：回复「不存在玩家信息」（禁止任何输出）
    → 有记录：GET 127.0.0.1:3067/api/player?uuid=<uuid>&width=700
      → 200：PNG 转 base64 → OneBot 图片段回复（群聊可顺带 @ 发送者）
      → 404：回复「玩家数据不存在」
      → 503 / 超时 / 网络错误：回复「渲染失败，请稍后重试」
  → 沿用 query_limit_seconds 限流
```

### 2. `卡片查询 <QQ号>`（仅管理员）

- 鉴权：`sender.user_id === config.notify_admin_qq`（或在 .env 新增 `ADMIN_QQS` 逗号分隔列表，推荐后者可多人）
- 非管理员：回复「该功能仅管理员可用」
- 逻辑同「我的信息」，但 QQ 取指令参数 `args[0]`（校验 5~11 位纯数字）
- 建议限制仅私聊可用（群内回复「请私聊我使用该功能」），避免泄露他人金币/领地统计

### 代码骨架（风格对齐现有指令，具体 API 以 node-napcat-ts 版本为准）

```js
registerCommand('我的信息', '', '查询自己的玩家信息卡片', async (args, quick_action, ctx) => {
    // 1. 从消息事件取发送者 QQ（参照现有指令如何拿 sender，必要时给 handler 传 ctx）
    const qq = String(ctx.sender.user_id);
    // 2. 查 verify_success.json
    const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }));
    const info = verify_data['records'].find(d => d.qq === qq);
    if (!info) return await quick_action(['⚠️不存在玩家信息！']);
    // 3. 拉渲染图（20s 超时）
    try {
        const resp = await fetch(`http://127.0.0.1:3067/api/player?uuid=${info.uuid}&width=700`,
            { signal: AbortSignal.timeout(20000) });
        if (resp.status === 404) return await quick_action(['⚠️玩家数据不存在！']);
        if (!resp.ok) return await quick_action(['⚠️渲染失败，请稍后重试！']);
        const buf = Buffer.from(await resp.arrayBuffer());
        // 4. 图片回复：OneBot11 图片段（node-napcat-ts: Structs.image）
        return await quick_action([Structs.image('base64://' + buf.toString('base64'))]);
    } catch (e) {
        return await quick_action(['⚠️渲染失败，请稍后重试！']);
    }
})
```

> 注意：现有 handler 签名是 `(args, quick_action)`，没有 sender 上下文——实施时需先看指令分发代码，
> 给 handler 补传 event/ctx（或参照 NapCat 事件对象在闭包内可取）。Structs.image 也支持 `file://` 本地路径，
> 亦可先写临时文件再发（同机部署 NapCat 时可用）。

## 七、边界与错误处理清单

| 情况 | 回复 |
| --- | --- |
| QQ 无 verify 记录 | 「不存在玩家信息」 |
| API 404 | 「玩家数据不存在」 |
| API 503 / 超时(>20s) / 连接失败 | 「渲染失败，请稍后重试」 |
| 非管理员用「卡片查询」 | 「该功能仅管理员可用」 |
| 管理员群内用「卡片查询」 | 「请私聊我使用该功能」 |
| 指令参数 QQ 格式错误 | 「QQ 号格式不正确」 |

- 不输出任何异常堆栈给用户；错误 console.error 留日志
- 渲染图含金币/领地统计，普通用户严格只能查自己（sender.user_id 不可伪造，天然安全）

## 八、验证步骤

1. `npm run start` 启动后，私聊机器人发「我的信息」→ 已验证 QQ 应收到 PNG 卡片
2. 未验证 QQ 发「我的信息」→ 「不存在玩家信息」
3. 群聊发「我的信息」→ 正常出图（确认 @ 回复行为）
4. 管理员私聊「卡片查询 <他人QQ>」→ 出对方卡片；非管理员 → 拒绝
5. 选一个 verify 记录里 uuid 已不在 admin 库的记录 → 应收到「玩家数据不存在」
6. 停掉 mclds-admin（3067 端口）→ 应收到「渲染失败，请稍后重试」且不崩溃

## 九、相关路径速查

| 项 | 路径 |
| --- | --- |
| 本项目 | `/www/wwwroot/mclds-napcat-bot`（`index.mjs`） |
| 绑定记录 | `/data/mclds/.verify_bot_data/verify_success.json` |
| 渲染 API | `http://127.0.0.1:3067/api/player`（mclds-admin，文档见 `/www/wwwroot/mclds-qq-bot/mclds-admin-api.md`） |
| 官方 bot（备选方案存档） | `/www/wwwroot/mclds-qq-bot` |
