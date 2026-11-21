// xingchi-session-keeper.middleware.mjs — magpie 网关中间件
//
// 作用：挂在「你已经在用的供应商」上（在插件选项里按供应商 id 启用，如 xingchi）。
// 当中转站按会话限制请求次数（如 XingChi 每会话 100 次，超限返回
// session_request_limit_exceeded）时，本中间件自动轮换会话标识：
//
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
  mark: "both",
  coolDownMs: 60000,
}

const DEFAULT_CODES = [
  "session_request_limit_exceeded",
  "session_limit_exceeded",
  "session_request_limit",
  "conversation_request_limit_exceeded",
  "conversation_limit_exceeded",
]

const DEFAULT_TEXT =
  "session_request_limit|已达到.{0,32}请求上限|会话.{0,16}(上限|已达到)|start a new session|新开一个会话|请新开|new session to continue|session has reached"

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
  out.providers = o.providers && typeof o.providers === "object" && !Array.isArray(o.providers) ? o.providers : {}
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
  return {
    maxRequests: toInt(per.maxRequests, opts.maxRequests, 0, 1000000),
    mark: ["none", "system", "first-user", "both"].indexOf(per.mark) >= 0 ? per.mark : opts.mark,
    coolDownMs: toInt(per.coolDownMs, opts.coolDownMs, 1000, 3600000),
    matchCodes: opts.matchCodes,
    matchText: opts.matchText,
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

    // Responses API（Codex）：删除请求体里的 prompt_cache_key——
    // Codex 把自己的会话 id 放在这里。不删掉的话，已耗尽的旧会话标识
    // 会继续传到上游，即使换了新会话标记也可能被归回旧会话。
    // 只对启用的供应商生效；上游地址、认证信息、tools 等业务字段一概不动。
    let strippedCacheKey = false
    if (kind === "responses" && body.prompt_cache_key !== undefined) {
      delete body.prompt_cache_key
      strippedCacheKey = true
      console.log(
        "session-keeper: " + String(ctx.provider.id) + " 已删除 Responses 请求的 prompt_cache_key（切断旧会话标识）",
      )
    }

    // 轮换与标记都关着时：剥完 cache key 就收工
    if (cfg.mark === "none" && cfg.maxRequests === 0) {
      return strippedCacheKey ? body : undefined
    }

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

    const marker = "[magpie-session:" + st.sid + "]"
    stripAllMarks(body, kind) // 抹掉上一轮注入的旧标记，防止堆积
    const didSystem = st.mark === "system" || st.mark === "both" ? markSystem(body, kind, marker) : false
    const didUser = st.mark === "first-user" || st.mark === "both" ? markFirstUser(body, kind, marker) : false
    if (kind === "anthropic") setMetadataSession(body, st.sid)

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
  state,
  onProvider,
  onEvent,
  onResponse,
  reset: function () {
    state.clear()
  },
}
