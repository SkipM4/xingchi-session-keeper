// xingchi-session-keeper.middleware.mjs — magpie 网关中间件
//
// 作用：挂在「你已经在用的供应商」上（在插件选项里按供应商 id 启用，如 xingchi）。
// 上游现在按「会话内模型回复轮数」限制（如 XingChi 每会话 100 轮，超限返回
// 「当前会话模型已回复 N 轮，达到上限，请 /compact 或 /new」）。光换会话 id
// 不够——Codex 每轮都带全量历史。本中间件因此：
//
//   0. 轮次压缩（核心）：请求体模型回复轮数超过 maxTurns 时，丢弃最旧轮次、
//      保留 system/instructions 与最近轮次，并强制换新会话标识。这样正常请求
//      与 magpie 的 remote compact 请求都不再撞上游上限；
//   1. 主动轮换：同一对话发到 maxRequests 次之前就换新会话标识；
//   2. 被动自愈：检测到回复里的会话上限错误后立即换新会话标识——
//      magpie 的故障切换重试同一供应商时自动进入全新会话；
//   3. 状态自恢复：会话标识写进请求体标记 [magpie-session:<id>]，
//      中间件重载丢内存后也能从对话历史里的旧标记恢复，不重复换会话。
//
// 会话标识以两种方式呈现，覆盖常见中转站的会话识别方式：
//   - 请求体标记：系统提示词 / 第一条用户消息开头的 [magpie-session:<id>]
//     （按对话前缀哈希识别会话的中转站）；
//   - Anthropic metadata.user_id 的 __session_ 段（Claude Code 类中转站）。
//
// 运行环境：moejs（magpie 网关进程内）。只有标准 JavaScript 和 console.log，
// 没有定时器、fetch 和 Node API——本文件严格遵守这些限制。
//
// 配置（magpie plugin options xingchi-session-keeper '<json>'）：
// {
//   "providers": { "xingchi": true, "my-relay": { "maxRequests": 40 } },
//   "maxTurns": 80,        // 轮次压缩阈值（上游每会话 100 轮就填 80–90；0 = 关闭）
//   "maxRequests": 80,     // 主动轮换阈值（默认 80，留出安全余量）
//   "mark": "both",        // 标记位置：none / system / first-user / both
//   "coolDownMs": 60000,   // 撞墙标记的有效期
//   "matchCodes": [...], "matchText": "..."
// }
// providers 的键写供应商 id（如 xingchi）；带前缀的 magpie:xingchi 也可以；
// 值 true/null/{} 用全局默认，对象则按供应商覆盖 maxRequests / mark / coolDownMs。

// ---------- 默认值 ----------

const DEFAULTS = {
  maxRequests: 80,
  maxTurns: 80,
  mark: "both",
  coolDownMs: 60000,
}

const DEFAULT_CODES = [
  "session_request_limit_exceeded",
  "session_limit_exceeded",
  "session_request_limit",
  "conversation_request_limit_exceeded",
  "conversation_limit_exceeded",
  "session_turn_limit_exceeded",
  "conversation_turn_limit_exceeded",
  "turn_limit_exceeded",
  "max_turns_exceeded",
]

const DEFAULT_TEXT =
  "session_request_limit|已达到.{0,32}请求上限|会话.{0,16}(上限|已达到)|start a new session|新开一个会话|请新开|new session to continue|session has reached|达到上限|回复.{0,10}轮|轮次上限|model turns|reached.{0,24}turns|请新建对话|run /compact"

const MARK_RE = /\[magpie-session:[0-9A-Za-z_-]{1,64}\]/g

// ---------- 基础工具（不依赖任何宿主 API） ----------

function fnv(str) {
  let h = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ("0000000" + h.toString(16)).slice(-8)
}

function uuid() {
  let s = ""
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-4" + s.slice(13, 16) + "-8" + s.slice(17, 20) + "-" + s.slice(20, 32)
}

function toInt(v, dflt, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" && String(v).trim() !== "" ? Number(v) : NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

function readOptions(raw) {
  const o = raw && typeof raw === "object" ? raw : {}
  const out = {}
  out.maxRequests = toInt(o.maxRequests, DEFAULTS.maxRequests, 0, 1000000)
  out.maxTurns = toInt(o.maxTurns, DEFAULTS.maxTurns, 0, 1000000)
  out.coolDownMs = toInt(o.coolDownMs, DEFAULTS.coolDownMs, 1000, 3600000)
  out.mark = ["none", "system", "first-user", "both"].indexOf(o.mark) >= 0 ? o.mark : DEFAULTS.mark
  const codes = {}
  for (const c of DEFAULT_CODES) codes[c] = true
  if (Array.isArray(o.matchCodes)) {
    for (const c of o.matchCodes) if (c) codes[String(c)] = true
  } else if (typeof o.matchCodes === "string") {
    for (const c of o.matchCodes.split(",")) if (c.trim()) codes[c.trim()] = true
  }
  out.matchCodes = codes
  out.matchText =
    typeof o.matchText === "string" && o.matchText.trim() !== "" ? o.matchText + "|" + DEFAULT_TEXT : DEFAULT_TEXT
  // package.json 里的 magpie.options 只是编辑框的起点：用户没保存过选项时
  // ctx.options 是空对象，这里会什么都匹配不到。因此 providers 缺省时
  // 默认启用 xingchi（与包名一致），显式配置永远优先。
  out.providers = o.providers && typeof o.providers === "object" && !Array.isArray(o.providers) ? o.providers : null
  out.defaulted = out.providers === null
  if (out.defaulted) out.providers = { xingchi: true }
  return out
}

// providers 的键匹配供应商 id：支持 "xingchi"、"magpie:xingchi"（取冒号后）和 "*"（全部）
function providerConfig(opts, providerId) {
  const p = opts.providers
  const keys = Object.keys(p)
  const id = String(providerId || "").toLowerCase()
  let hit = null
  for (const k of keys) {
    const kk = k.indexOf(":") >= 0 ? k.slice(k.lastIndexOf(":") + 1) : k
    if (kk === "*" || kk.toLowerCase() === id) hit = p[k]
  }
  if (hit === undefined || hit === null || hit === false) return null
  const per = hit && typeof hit === "object" ? hit : {}
  const sf = ["replace", "strip", "off"].indexOf(per.sessionFields) >= 0
    ? per.sessionFields
    : ["replace", "strip", "off"].indexOf(opts.sessionFields) >= 0
      ? opts.sessionFields
      : "replace"
  return {
    maxRequests: toInt(per.maxRequests, opts.maxRequests, 0, 1000000),
    maxTurns: toInt(per.maxTurns, opts.maxTurns, 0, 1000000),
    mark: ["none", "system", "first-user", "both"].indexOf(per.mark) >= 0 ? per.mark : opts.mark,
    coolDownMs: toInt(per.coolDownMs, opts.coolDownMs, 1000, 3600000),
    matchCodes: opts.matchCodes,
    matchText: opts.matchText,
    sessionFields: sf,
    stripSessionId: per.stripSessionId !== undefined ? per.stripSessionId : opts.stripSessionId !== false,
  }
}

// ---------- 请求体（agent API 格式）访问 ----------

// kind = ctx.protocol: "chat" | "anthropic" | "responses" | "gemini"

function messageText(content, type) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = []
    for (const p of content) {
      if (typeof p === "string") parts.push(p)
      else if (p && typeof p === "object" && p.type === type && typeof p.text === "string") parts.push(p.text)
    }
    return parts.join("\n")
  }
  return null
}

// 第一条用户消息的文本：同一段对话内稳定，用作会话键
function firstUserText(body, kind) {
  if (!body || typeof body !== "object") return null
  if (kind === "responses") {
    if (typeof body.input === "string") return body.input
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (item && typeof item === "object" && item.role === "user") return messageText(item.content, "input_text")
      }
    }
    return null
  }
  if (kind === "gemini") {
    const arr = Array.isArray(body.contents) ? body.contents : []
    for (const m of arr) {
      if (m && typeof m === "object" && m.role === "user" && Array.isArray(m.parts)) {
        const t = m.parts
          .map(function (p) {
            return p && typeof p.text === "string" ? p.text : ""
          })
          .join("\n")
        if (t) return t
      }
    }
    return null
  }
  const msgs = Array.isArray(body.messages) ? body.messages : []
  for (const m of msgs) {
    if (m && typeof m === "object" && m.role === "user") return messageText(m.content, "text")
  }
  return null
}

// 会话键：Anthropic metadata 自带的 session id 优先，否则第一条用户消息哈希
function convKeyOf(body, kind, providerId) {
  if (kind === "anthropic" && body && body.metadata && typeof body.metadata.user_id === "string") {
    const m = /__session_([0-9A-Za-z_-]{6,})/.exec(body.metadata.user_id)
    if (m) return providerId + "|m:" + m[1]
  }
  const t = firstUserText(body, kind)
  if (t) return providerId + "|u:" + fnv(t)
  return providerId + "|x"
}

// ---------- 标记注入（抹掉旧标记 + 写入新标记） ----------

// 去掉文本里所有旧标记（防止标记随对话轮次堆积、浪费 token）
function stripMarks(text) {
  if (typeof text !== "string" || text.indexOf("[magpie-session:") < 0) return text
  const out = text.replace(MARK_RE, "")
  // 清掉标记行遗留的空行（标记后紧跟的换行）
  return out.replace(/^[ \t]*\r?\n+/, "")
}

function prependMarker(text, marker) {
  return marker + "\n\n" + (typeof text === "string" ? text : "")
}

// 在「系统提示词位置」写标记；返回是否写入了
function markSystem(body, kind, marker) {
  if (kind === "chat") {
    const msgs = Array.isArray(body.messages) ? body.messages : null
    if (!msgs) return false
    for (const m of msgs) {
      if (m && typeof m === "object" && m.role === "system") {
        if (typeof m.content === "string") m.content = prependMarker(stripMarks(m.content), marker)
        else if (Array.isArray(m.content)) {
          const first = m.content[0]
          if (typeof first === "string") m.content[0] = prependMarker(stripMarks(first), marker)
          else if (first && typeof first === "object" && first.type === "text")
            first.text = prependMarker(stripMarks(first.text), marker)
          else m.content.unshift({ type: "text", text: marker })
        } else if (m.content === undefined || m.content === null) m.content = marker
        return true
      }
    }
    msgs.unshift({ role: "system", content: marker })
    return true
  }
  if (kind === "anthropic") {
    const sys = body.system
    if (sys === undefined || sys === null) {
      body.system = marker
      return true
    }
    if (typeof sys === "string") {
      body.system = prependMarker(stripMarks(sys), marker)
      return true
    }
    if (Array.isArray(sys)) {
      const first = sys[0]
      if (first && typeof first === "object" && first.type === "text") first.text = prependMarker(stripMarks(first.text), marker)
      else sys.unshift({ type: "text", text: marker })
      return true
    }
    return false
  }
  if (kind === "responses") {
    if (typeof body.instructions === "string") body.instructions = prependMarker(stripMarks(body.instructions), marker)
    else if (body.instructions === undefined || body.instructions === null) body.instructions = marker
    return true
  }
  if (kind === "gemini") {
    const si = body.systemInstruction
    if (si && typeof si === "object" && Array.isArray(si.parts)) {
      const first = si.parts[0]
      if (first && typeof first === "object" && typeof first.text === "string")
        first.text = prependMarker(stripMarks(first.text), marker)
      else si.parts.unshift({ text: marker })
      return true
    }
    body.systemInstruction = { parts: [{ text: marker }] }
    return true
  }
  return false
}

// 在「第一条用户消息开头」写标记
function markFirstUser(body, kind, marker) {
  if (kind === "responses" && typeof body.input === "string") {
    body.input = prependMarker(stripMarks(body.input), marker)
    return true
  }
  let msg = null
  if (kind === "gemini") {
    const arr = Array.isArray(body.contents) ? body.contents : []
    for (const m of arr) {
      if (m && typeof m === "object" && m.role === "user") {
        msg = m
        break
      }
    }
    if (!msg) return false
    if (!Array.isArray(msg.parts)) msg.parts = []
    const first = msg.parts[0]
    if (first && typeof first === "object" && typeof first.text === "string")
      first.text = prependMarker(stripMarks(first.text), marker)
    else msg.parts.unshift({ text: marker })
    return true
  }
  const list =
    kind === "responses"
      ? Array.isArray(body.input)
        ? body.input
        : []
      : Array.isArray(body.messages)
        ? body.messages
        : []
  for (const m of list) {
    if (m && typeof m === "object" && m.role === "user") {
      msg = m
      break
    }
  }
  if (!msg) return false
  const blockType = kind === "responses" ? "input_text" : "text"
  if (typeof msg.content === "string") {
    msg.content = prependMarker(stripMarks(msg.content), marker)
    return true
  }
  if (Array.isArray(msg.content)) {
    const first = msg.content[0]
    if (typeof first === "string") msg.content[0] = prependMarker(stripMarks(first), marker)
    else if (first && typeof first === "object" && first.type === blockType)
      first.text = prependMarker(stripMarks(first.text), marker)
    else msg.content.unshift({ type: blockType, text: marker })
    return true
  }
  if (msg.content === undefined || msg.content === null) msg.content = marker
  return true
}

// 从整个请求体里抹掉所有旧标记
function stripAllMarks(body, kind) {
  function stripList(list) {
    if (!Array.isArray(list)) return
    for (const m of list) {
      if (!m || typeof m !== "object") continue
      if (typeof m.content === "string" && m.content.indexOf("[magpie-session:") >= 0) m.content = stripMarks(m.content)
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (typeof p === "string" && p.indexOf("[magpie-session:") >= 0) p = stripMarks(p)
          else if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf("[magpie-session:") >= 0)
            p.text = stripMarks(p.text)
        }
      }
    }
  }
  if (kind === "responses") {
    if (typeof body.input === "string" && body.input.indexOf("[magpie-session:") >= 0) body.input = stripMarks(body.input)
    else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!item || typeof item !== "object") continue
        if (typeof item.content === "string" && item.content.indexOf("[magpie-session:") >= 0)
          item.content = stripMarks(item.content)
        else if (Array.isArray(item.content)) {
          for (const p of item.content) {
            if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf("[magpie-session:") >= 0)
              p.text = stripMarks(p.text)
          }
        }
      }
    }
    if (typeof body.instructions === "string" && body.instructions.indexOf("[magpie-session:") >= 0)
      body.instructions = stripMarks(body.instructions)
    return
  }
  if (kind === "gemini") {
    const arr = Array.isArray(body.contents) ? body.contents : []
    for (const m of arr) {
      if (!m || typeof m !== "object" || !Array.isArray(m.parts)) continue
      for (const p of m.parts) {
        if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf("[magpie-session:") >= 0)
          p.text = stripMarks(p.text)
      }
    }
    const si = body.systemInstruction
    if (si && typeof si === "object" && Array.isArray(si.parts)) {
      for (const p of si.parts) {
        if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf("[magpie-session:") >= 0)
          p.text = stripMarks(p.text)
      }
    }
    return
  }
  stripList(body.messages)
  if (kind === "anthropic") {
    if (typeof body.system === "string" && body.system.indexOf("[magpie-session:") >= 0) body.system = stripMarks(body.system)
    else if (Array.isArray(body.system)) {
      for (const p of body.system) {
        if (p && typeof p === "object" && typeof p.text === "string" && p.text.indexOf("[magpie-session:") >= 0)
          p.text = stripMarks(p.text)
      }
    }
  }
}

// 在 Anthropic metadata.user_id 上体现会话标识
function setMetadataSession(body, sid) {
  if (!body || typeof body !== "object") return false
  const meta = body.metadata
  if (!meta || typeof meta !== "object" || typeof meta.user_id !== "string") return false
  const uid = meta.user_id
  const i = uid.indexOf("__session_")
  meta.user_id = (i >= 0 ? uid.slice(0, i) : uid) + "__session_" + sid
  return true
}

// 从请求体里找回已有的会话标识（中间件重载后恢复状态）
function existingMarkSid(body, kind) {
  function scan(text) {
    if (typeof text !== "string") return null
    const m = /\[magpie-session:([0-9A-Za-z_-]{1,64})\]/.exec(text)
    return m ? m[1] : null
  }
  if (kind === "anthropic" && body && body.metadata && typeof body.metadata.user_id === "string") {
    const m = /__session_([0-9A-Za-z_-]{6,})/.exec(body.metadata.user_id)
    if (m) return m[1]
  }
  const sysText =
    body && (body.system !== undefined ? (typeof body.system === "string" ? body.system : null) : null)
  const r = scan(sysText) || scan(body && typeof body.instructions === "string" ? body.instructions : null)
  if (r) return r
  return scan(firstUserText(body, kind))
}

// ---------- 轮次压缩（应对上游「每会话最多 N 轮」策略） ----------

// 取请求体里的对话消息列表
function convList(body, kind) {
  if (!body || typeof body !== "object") return null
  if (kind === "responses") return Array.isArray(body.input) ? body.input : null
  if (kind === "gemini") return Array.isArray(body.contents) ? body.contents : null
  return Array.isArray(body.messages) ? body.messages : null
}

function setConvList(body, kind, list) {
  if (kind === "responses") body.input = list
  else if (kind === "gemini") body.contents = list
  else body.messages = list
}

// 是否「模型回复」——计入上游的轮次
function isModelReply(m, kind) {
  if (!m || typeof m !== "object") return false
  if (kind === "gemini") return m.role === "model"
  if (kind === "responses") return m.type === "function_call" || m.role === "assistant"
  return m.role === "assistant"
}

function countModelReplies(list, kind) {
  let c = 0
  for (const m of list) if (isModelReply(m, kind)) c++
  return c
}

// 是否「一轮对话的起点」（真正的用户发言；工具结果不算）
function isTurnStart(m, kind) {
  if (!m || typeof m !== "object") return false
  if (kind === "anthropic") {
    if (m.role !== "user") return false
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (!b || typeof b !== "object" || b.type !== "tool_result") return true
      return false
    }
    return true
  }
  return m.role === "user"
}

function isSystemLike(m) {
  if (!m || typeof m !== "object") return false
  return m.role === "system" || m.role === "developer"
}

// 轮次压缩：请求体模型回复轮数超过 maxTurns 时，只保留最近的若干轮对话，
// 使上游按「每会话最多 N 轮」计数时不再撞墙。返回 null（未压缩）或 { dropped, kept }。
function trimTurns(body, kind, maxTurns) {
  if (!(maxTurns > 0)) return null
  const list = convList(body, kind)
  if (!Array.isArray(list) || list.length === 0) return null
  const total = countModelReplies(list, kind)
  if (total <= maxTurns) return null

  // 保留列表开头的 system/developer（不占轮次，丢了会丢人设/指令）
  let headEnd = 0
  while (headEnd < list.length && isSystemLike(list[headEnd])) headEnd++
  const head = list.slice(0, headEnd)
  const rest = list.slice(headEnd)

  // 候选切点：每轮用户发言的起点（不在工具结果上切断，避免孤立工具调用）
  const starts = []
  for (let i = 0; i < rest.length; i++) if (isTurnStart(rest[i], kind)) starts.push(i)

  let cut = -1
  for (const s of starts) {
    let c = 0
    for (let i = s; i < rest.length; i++) if (isModelReply(rest[i], kind)) c++
    if (c <= maxTurns) {
      cut = s
      break
    }
  }
  if (cut < 0) cut = starts.length ? starts[starts.length - 1] : Math.max(0, rest.length - 1)

  const kept = head.concat(rest.slice(cut))
  setConvList(body, kind, kept)
  return { dropped: total - countModelReplies(kept, kind), kept: kept.length }
}

// ---------- 错误识别 ----------

// 判断一个回复对象（事件 data JSON 或非流式回复体）是否是会话上限错误
function isLimitError(obj, status, cfg) {
  if (!obj || typeof obj !== "object") return false
  const err = obj.error
  if (err && typeof err === "object") {
    const code = err.code !== undefined ? err.code : err.type
    if (code !== undefined && cfg.matchCodes[String(code)]) return true
    const msg = typeof err.message === "string" ? err.message : ""
    if (msg) {
      try {
        if (new RegExp(cfg.matchText, "i").test(msg)) return true
      } catch (e) {}
    }
  }
  if (status !== undefined && status >= 400) {
    try {
      const text = JSON.stringify(obj)
      if (text && new RegExp(cfg.matchText, "i").test(text)) return true
    } catch (e) {}
  }
  return false
}

// 快速粗筛：事件里有没有 error 字段（避免每个小事件都做正则）
function hasErrorField(ev) {
  if (!ev || typeof ev !== "object") return false
  if (ev.error !== undefined) return true
  if (Array.isArray(ev.choices)) {
    for (const c of ev.choices) {
      if (c && typeof c === "object" && c.error !== undefined) return true
    }
  }
  return false
}

// ---------- 会话状态（跨请求；重载即清空，可从请求体标记恢复） ----------

// key: "<providerId>|<convKey>" → { sid, count, mark, limitedAt, last }
const state = new Map()

function pruneState() {
  if (state.size <= 512) return
  const entries = []
  for (const e of state.entries()) entries.push(e)
  entries.sort(function (a, b) {
    return (a[1].last || 0) - (b[1].last || 0)
  })
  for (let i = 0; i < 128 && i < entries.length; i++) state.delete(entries[i][0])
}

// ---------- 钩子 ----------

// 请求即将发往某个供应商：在这里注入/轮换会话标识。
// ctx.provider 有 id/name/account/model；ctx.protocol 是 agent 的 API 格式。
export function onProvider(body, ctx) {
  try {
    if (!body || typeof body !== "object" || !ctx || !ctx.provider) return undefined
    const opts = readOptions(ctx.options)
    const cfg = providerConfig(opts, ctx.provider.id)
    if (!cfg) return undefined // 该供应商未启用：原样发送（头与请求体都不动）

    const kind = ctx.protocol || "chat"
    const key = convKeyOf(body, kind, String(ctx.provider.id || ""))

    pruneState()
    let st = state.get(key)
    const now = Date.now()
    if (!st) {
      // 重载后恢复：沿用请求体里已有的会话标识，避免无谓换会话
      const prev = existingMarkSid(body, kind)
      st = { sid: prev || uuid(), count: 0, mark: cfg.mark, limitedAt: 0, last: now }
      state.set(key, st)
    }
    st.last = now
    st.count += 1
    st.mark = st.mark === "both" ? "both" : cfg.mark

    // 被动自愈：最近撞过墙 → 立即换新会话（magpie 故障切换重试时正好用上）
    let rotated = false
    if (st.limitedAt && now - st.limitedAt < cfg.coolDownMs) {
      st.sid = uuid()
      st.count = 1
      st.mark = "both" // 升级到最强标记，确保中转站认成新会话
      st.limitedAt = 0
      rotated = true
    } else if (st.limitedAt) {
      st.limitedAt = 0
    }
    // 主动轮换：达到阈值前换新会话，尽量不触发上限
    if (!rotated && cfg.maxRequests > 0 && st.count > cfg.maxRequests) {
      st.sid = uuid()
      st.count = 1
      st.mark = "both"
      rotated = true
    }

    // 轮次压缩：请求体里的模型回复轮数超过 maxTurns 时，丢掉最旧的轮次、只留最近的。
    // 上游按「每会话最多 N 轮」计上限，光换会话 id 没用（Codex 每轮都带全量历史）——
    // 必须真正缩短对话内容。压缩同时换新会话标识：按会话累计轮数的中转站也会因此重置计数。
    const trimmed = trimTurns(body, kind, cfg.maxTurns)
    if (trimmed) {
      st.sid = uuid()
      st.count = 1
      st.mark = "both"
      rotated = true
      console.log(
        "session-keeper: " +
          String(ctx.provider.id) +
          " 已压缩会话上下文（丢弃 " +
          trimmed.dropped +
          " 轮旧对话，保留 " +
          trimmed.kept +
          " 条消息）并换新会话",
      )
    }

    const marker = "[magpie-session:" + st.sid + "]"
    stripAllMarks(body, kind) // 抹掉上一轮注入的旧标记，防止堆积
    const didSystem = st.mark === "system" || st.mark === "both" ? markSystem(body, kind, marker) : false
    const didUser = st.mark === "first-user" || st.mark === "both" ? markFirstUser(body, kind, marker) : false
    if (kind === "anthropic") setMetadataSession(body, st.sid)

    // 会话字段改写（默认 replace）：
    //   replace — 把轮换的会话 id 写进 prompt_cache_key / session_id（原字段存在才写）。
    //             Codex 的原值（请求头带来的会话标识）会被我们轮换的值替换，
    //             中转站按 body 归会话时完全可控；只读头的站也至少不再收到旧值。
    //   strip   — 删除这两个字段（v0.2.0 行为）。
    //   off     — 不动。
    let touched = []
    if (cfg.sessionFields !== "off") {
      if (body.prompt_cache_key !== undefined) {
        if (cfg.sessionFields === "strip") delete body.prompt_cache_key
        else body.prompt_cache_key = st.sid
        touched.push("prompt_cache_key")
      }
      if (cfg.sessionFields !== "strip" || cfg.stripSessionId !== false) {
        if (body.session_id !== undefined) {
          if (cfg.sessionFields === "strip") delete body.session_id
          else body.session_id = st.sid
          touched.push("session_id")
        }
      }
    }
    if (touched.length > 0) {
      console.log(
        "session-keeper: " +
          String(ctx.provider.id) +
          " 会话标识字段已改写为轮换值（" +
          touched.join(", ") +
          " → " +
          st.sid.slice(0, 8) +
          "…）",
      )
    }

    if (rotated || didSystem || didUser) {
      console.log(
        "session-keeper: " +
          String(ctx.provider.id) +
          (rotated ? " 已轮换到新会话" : " 会话标记已注入") +
          "（该对话第 " +
          st.count +
          " 次请求）",
      )
    }

    // 供同一次请求的 onEvent / onResponse 使用
    if (ctx.state) {
      ctx.state.__sk_key = key
      ctx.state.__sk_sid = st.sid
    }
    return body
  } catch (e) {
    return undefined // 出错时当作中间件不存在，请求按原样发送
  }
}

// 流式回复的每个事件：检测会话上限错误，标记撞墙（不修改事件本身）
export function onEvent(ev, ctx) {
  try {
    if (!ctx || !ctx.state || !ctx.state.__sk_key) return undefined
    if (!hasErrorField(ev)) return undefined
    const opts = readOptions(ctx.options)
    const key = ctx.state.__sk_key
    const cfg = perKeyConfig(opts, key)
    if (!cfg) return undefined
    if (isLimitError(ev, undefined, cfg)) {
      const st = state.get(key)
      if (st) {
        st.limitedAt = Date.now()
        console.log(
          "session-keeper: 供应商返回会话请求上限（会话 " +
            String(ctx.state.__sk_sid).slice(0, 8) +
            "…），下次请求将自动换新会话",
        )
      }
    }
    return undefined
  } catch (e) {
    return undefined
  }
}

// 非流式回复：同样检测会话上限错误
export function onResponse(body, ctx) {
  try {
    if (!ctx || !ctx.state || !ctx.state.__sk_key) return undefined
    if (!body || typeof body !== "object" || body.error === undefined) return undefined
    const opts = readOptions(ctx.options)
    const key = ctx.state.__sk_key
    const cfg = perKeyConfig(opts, key)
    if (!cfg) return undefined
    const status = typeof ctx.status === "number" ? ctx.status : undefined
    if (isLimitError(body, status, cfg)) {
      const st = state.get(key)
      if (st) {
        st.limitedAt = Date.now()
        console.log("session-keeper: 供应商返回会话请求上限，下次请求将自动换新会话")
      }
    }
    return undefined
  } catch (e) {
    return undefined
  }
}

// key 形如 "<providerId>|<convKey>"：从 key 还原该供应商的配置
function perKeyConfig(opts, key) {
  const i = key.indexOf("|")
  const providerId = i >= 0 ? key.slice(0, i) : key
  return providerConfig(opts, providerId)
}

// 仅供单元测试：不参与 magpie 的钩子发现
export const _internal = {
  fnv,
  uuid,
  readOptions,
  providerConfig,
  convKeyOf,
  firstUserText,
  markSystem,
  markFirstUser,
  stripAllMarks,
  setMetadataSession,
  existingMarkSid,
  isLimitError,
  hasErrorField,
  trimTurns,
  isModelReply,
  isTurnStart,
  countModelReplies,
  state,
  onProvider,
  onEvent,
  onResponse,
  reset: function () {
    state.clear()
  },
}
