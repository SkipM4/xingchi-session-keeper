# XingChi Session Keeper（magpie 网关中间件）

把 magpie 已在用的供应商（如 XingChi 中转站）从「每会话上限」里解放出来。上游现在按**会话内的模型回复轮数**计上限（如每会话 100 轮，超限返回「已回复 N 轮，请 /compact 或 /new」），**光换会话 id 已经不够**——Codex 每轮都带完整历史，换 id 后上游依然按对话内容数轮次。

本中间件在请求发往供应商之前，**本地压缩对话轮次**（滑动窗口，保留 system/instructions + 最近若干轮），并在压缩时强制换新会话标识。这样每个请求的轮数都低于上游上限，正常请求和 magpie 的 remote compact 请求都不会再撞墙。

纯网关中间件——挂在你**已有的**供应商和登录上（内置订阅、API key、别的插件提供的供应商都行），自己不做任何登录。

## 核心机制：轮次压缩

上游按「会话内模型已回复多少轮」计数（应答里常见「当前会话模型已回复 105 轮，达到上限」）。压缩请求同样会带上全量历史，所以 magpie 的 remote compact 也会失败。

中间件在每次请求前做两件事：

1. **轮次压缩**（`maxTurns`，默认 65）：按请求体计算轮数，超过目标即只保留列表开头的 `system`/`developer` 与**最近的若干轮**，丢弃中间的旧轮次。切点只落在「真实用户发言」的起点，不会切开工具调用/工具结果，避免孤立 `tool_use`。
2. **换新会话标识**：一旦发生压缩，立即分配新会话 id，并同步到会话标记与字段改写。按会话累计轮数的中转站也会因此重置计数。

压缩目标不是固定值，始终留在上游 100 轮硬上限之下：

| 情形 | 目标 |
| --- | --- |
| 常规 | `maxTurns`（默认 65） |
| 请求体已达 100 轮（如上游报的 105 轮） | 强制深压到 60 |
| remote compact 请求（指令里含 summarize/摘要/compact） | ≤ 50 |
| 该对话曾撞过墙 | 目标减半（下限 8），并一直保持收紧 |

计数取「轮数」而非仅 `assistant` 条数——reasoning、`function_call` 都算进所属轮，只会高估不会低估，因此压缩后必然低于上游计数。

保留 system/instructions 意味着人设与指令不丢；模型仍能通过最近若干轮消息保持上下文延续。代价是更早的对话会被裁掉——这正是上游新策略要求的「压缩上下文」。

## 会话标识字段改写（Codex / Responses 及兼容客户端）

对发往启用供应商的请求体里的 `prompt_cache_key` / `session_id` 字段，提供三种模式（选项 `sessionFields`，默认 `replace`）：

- **`replace`（默认）**：把轮换的会话 id **写入**这两个字段（原字段存在才写）；
- **`strip`**：删除这两个字段；
- **`off`**：不动。

不依赖协议判断（只认字段存在），模型、`tools`、`instructions`、`store`、认证信息等一概不动；未启用的供应商请求原样放行。

## 版本变更

**0.5.0**：修复 0.4.0 仍会撞墙的三个缺陷——(1) 计数只数 `assistant`，漏掉 reasoning / `function_call`，上游 105 轮时我们只数出 ~85 轮而不压缩；现按用户轮计数（高估不低估）。(2) 目标写死 80，与上游 100 只差 20 轮余量，抖动一次就超；现改为动态目标：硬上限时深压到 60、compact 请求压到 50、撞过墙的对话减半收紧。(3) 未识别 remote compact 请求（它带全量历史，是 magpie 反复失败的主因），现单独施压。

**0.4.0**：上游改为按**会话内轮数**限制（每会话 100 轮）。新增 `maxTurns` 轮次压缩。旧版「只换会话 id」在按轮数计数的策略下失效。

**0.3.0**：`sessionFields` 默认从删除改为 `replace`——把轮换会话 id 写进 `prompt_cache_key` / `session_id`。

**0.2.0**：未保存选项时默认启用 `xingchi`；剥离不再依赖 `ctx.protocol`；`session_id` 字段纳入处理。

## 原理（会话识别）

除轮次压缩外，中间件也会改写中转站用于识别会话的特征，覆盖不同实现：

- 系统提示词 / 第一条用户消息开头的 `[magpie-session:<id>]` 标记；
- Anthropic 请求 `metadata.user_id` 的 `__session_` 段（Claude Code 类）；
- 请求体 `prompt_cache_key` / `session_id` 字段（见上）。

这些标记每轮注入前会抹掉旧的，不随对话轮次堆积、不浪费 token。

被动的撞墙自愈仍在：流式事件或非流式回复里检出会话上限错误（错误码或中英文提示文本）后标记撞墙，下一个请求换新会话。

## 安装

```sh
magpie plugin add ./xingchi-session-keeper
```

## 配置（按供应商启用）

```sh
magpie plugin options xingchi-session-keeper '{"providers": {"xingchi": true}}'
```

```jsonc
{
  "providers": {
    "xingchi": true,          // 供应商 id，magpie:xingchi 也可以；"*" 对全部供应商启用
    "my-relay": { "maxTurns": 60, "maxRequests": 40 }  // 按供应商覆盖参数
  },
  "maxTurns": 65,             // 常规轮次压缩目标（上游 100 就填 60–80；0 = 关闭）
  "maxRequests": 80,          // 主动轮换阈值（按请求次数；0 = 关闭）
  "mark": "both",             // 标记位置：none / system / first-user / both
  "coolDownMs": 60000,        // 撞墙后的换会话窗口
  "sessionFields": "replace", // 会话字段改写：replace / strip / off
  "matchCodes": [],           // 额外的错误码匹配（默认已含 session/turn limit 等）
  "matchText": ""             // 额外的文本匹配（默认已含中英文「轮数/达到上限」提示）
}
```

供应商 id 在 magpie 的「供应商」页或 `magpie provider` 输出里查。改完从下一个请求起生效（magpie 每秒检查文件变化，或用 `magpie plugin options` 触发重载）。

## 观察效果

- magpie 日志里 `session-keeper: xingchi 已压缩会话上下文（丢弃 N 轮旧对话…）并换新会话`；
- 设置 → 插件里能看到钩子调用次数、耗时和失败数；
- 中间件出错时请求按原样发送，绝不阻塞正常流量。

## 限制

- moejs 环境：无 fetch / 定时器，所有逻辑是纯同步计算（对延迟无影响，事件钩子微秒级）；
- 轮次压缩是**滑动窗口截断**（本地无法调用模型做摘要），保留 system/instructions 与最近轮次，更早的对话会被裁掉；
- magpie 的 remote compact 请求会被压到 ≤50 轮，因此抓到的摘要只覆盖最近轮次；压缩后每轮都在上限以下，正常不用再 compact；
- 若仍在报错：说明上游计数口径与本地差别大，把 `maxTurns` 降到 40 左右；连续撞墙时插件会自动减半收紧，一次会话里最多降到 8 轮；
- 极长的单一任务在深压后早期上下文会缺失，必要时开新会话（`/new`）比继续压更好；
- 会话计数在 magpie 进程内存里，重启后从请求体标记恢复。

## 测试

```sh
cd xingchi-session-keeper && node --test test.mjs
```
