# XingChi Session Keeper（magpie 网关中间件）

把 magpie 已在用的供应商（如 XingChi 中转站）从「每会话 100 次请求上限」里解放出来：
**撞到上限时自动换一个新会话继续**，你不用再手动新开会话，agent 的对话上下文一个字不丢。

它是纯网关中间件——挂在你**已有的**供应商和登录上（内置订阅、API key、别的插件提供的供应商都行），自己不做任何登录。

## 会话标识字段改写（Codex / Responses 及兼容客户端）

对发往启用供应商的请求体里的 `prompt_cache_key` / `session_id` 字段，提供三种模式（选项 `sessionFields`，默认 `replace`）：

- **`replace`（默认）**：把轮换的会话 id **写入**这两个字段（原字段存在才写）。Codex 带来的旧会话标识被替换，中转站按 body 归会话时完全可控——轮换时字段值同步变化；
- **`strip`**：删除这两个字段（v0.2.0 行为）；
- **`off`**：不动。

不依赖协议判断（只认字段存在），模型、`tools`、`instructions`、`store`、认证信息等一概不动；未启用的供应商请求原样放行。即使把 `mark` 设为 `none`、`maxRequests` 设为 0（关闭标记与轮换），字段改写依然生效。

## 版本变更

**0.3.0**：`sessionFields` 默认从删除改为 `replace`——把轮换会话 id 写进 `prompt_cache_key` / `session_id`（实测仅删除字段不够：magpie 详情里「会话 ID」来自 Codex 的请求头，仅删 body 字段时上游仍按旧会话归因；改写后 body 值优先可控）。

**0.2.0**：未保存选项时默认启用 `xingchi`（`package.json` 建议选项在保存前运行时拿不到，之前导致不生效）；剥离不再依赖 `ctx.protocol`；`session_id` 字段纳入处理。

## 原理

中转站判断「这是不是新会话」看的是**请求特征**（会话头、metadata、对话前缀的哈希），不是你客户端里的那条对话。本中间件在请求发往启用的供应商之前，把会话标识写进请求的两个位置：

- 系统提示词 / 第一条用户消息开头的 `[magpie-session:<id>]` 标记——按对话前缀识别会话的中转站会把它算进「对话内容」，标识一换就是一段全新对话；
- Anthropic 请求 `metadata.user_id` 的 `__session_` 段（Claude Code 类）。

轮换时机：

1. **主动轮换**：同一对话发到 `maxRequests`（默认 80，留出安全余量）次之前就换新标识，尽量不触发上限；
2. **被动自愈**：流式事件或非流式回复里检出 `session_request_limit_exceeded`（错误码或中英文提示文本）后立即换新标识——magpie 故障切换重试同一供应商时正好进入全新会话；
3. **状态恢复**：中间件重载丢内存后，从对话历史里的旧标记找回会话标识，不会无谓换会话。

每轮注入前会抹掉上一轮的旧标记，标记不随对话轮次堆积、不浪费 token。

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
    "my-relay": { "maxRequests": 40 }  // 按供应商覆盖参数
  },
  "maxRequests": 80,          // 主动轮换阈值（你的站上限 100 就填 80–90）
  "mark": "both",             // 标记位置：none / system / first-user / both
  "coolDownMs": 60000,        // 撞墙后的换会话窗口
  "matchCodes": [],           // 额外的错误码匹配（默认已含 session_request_limit_exceeded 等）
  "matchText": ""             // 额外的文本匹配（默认已含中英文「新开会话」提示）
}
```

供应商 id 在 magpie 的「供应商」页或 `magpie provider` 输出里查。改完从下一个请求起生效（magpie 每秒检查文件变化，或用 `magpie plugin options` 触发重载）。

## 观察效果

- magpie 日志里 `session-keeper: xingchi 已轮换到新会话（该对话第 N 次请求）`；
- 设置 → 插件里能看到钩子调用次数、耗时和失败数；
- 中间件出错时请求按原样发送，绝不阻塞正常流量。

## 限制

- moejs 环境：无 fetch / 定时器，所有逻辑是纯同步计算（对延迟无影响，事件钩子微秒级）；
- 会话计数在 magpie 进程内存里，重启后从请求体标记恢复；
- 换会话无法保留中转站侧的上下文缓存（如果它有缓存的话）——但 agent 的对话历史完整，模型上下文不受影响。

## 测试

```sh
cd xingchi-session-keeper && node --test test.mjs
```
