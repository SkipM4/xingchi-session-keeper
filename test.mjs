// test.mjs — 中间件逻辑单元测试（node --test，不依赖任何宿主 API）
// 注意：magpie 不加载本文件（package.json 的 magpie.middleware 只指向 .middleware.mjs），
// 这里只是开发时验证逻辑。

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { onProvider, onEvent, onResponse, _internal } from "./xingchi-session-keeper.middleware.mjs"

// 内部函数从 _internal 解构（钩子本身是具名导出，与 magpie 的发现方式一致）
const {
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
  state,
  reset,
} = _internal

const LIMIT_EV = {
  error: {
    code: "session_request_limit_exceeded",
    message:
      "XingChi: 当前会话已达到 100 次请求上限，请新开一个会话后继续（Codex 输入 /new，其他客户端新建对话）。This session has reached the limit of 100 requests. Please start a new session to continue.",
    type: "invalid_request_error",
  },
}

function mkCtx(providerId, options, protocol = "chat") {
  return {
    provider: { id: providerId, name: providerId },
    protocol,
    state: {},
    options,
  }
}

describe("选项解析", () => {
  test("readOptions 默认值（含未配置时默认启用 xingchi）", () => {
    const o = readOptions(undefined)
    assert.equal(o.maxRequests, 80)
    assert.equal(o.mark, "both")
    assert.equal(o.coolDownMs, 60000)
    assert.ok(o.matchCodes["session_request_limit_exceeded"])
    assert.ok(o.defaulted) // 没保存过选项
    assert.deepEqual(o.providers, { xingchi: true }) // 默认启用 xingchi
    const saved = readOptions({ providers: { my: true } })
    assert.equal(saved.defaulted, false) // 显式配置优先
    assert.deepEqual(saved.providers, { my: true })
  })

  test("providerConfig 按供应商 id 匹配（支持前缀与 *）", () => {
    const o = readOptions({ providers: { "magpie:xingchi": true, "my-relay": { maxRequests: 40 } } })
    assert.ok(providerConfig(o, "xingchi")) // magpie:xingchi → 冒号后匹配
    assert.equal(providerConfig(o, "XingChi").maxRequests, 80) // 大小写不敏感
    assert.equal(providerConfig(o, "my-relay").maxRequests, 40) // 按供应商覆盖
    assert.equal(providerConfig(o, "other"), null) // 未启用
    const all = readOptions({ providers: { "*": true } })
    assert.ok(providerConfig(all, "anything"))
    assert.equal(providerConfig(readOptions({ providers: { xingchi: false } }), "xingchi"), null) // false = 关闭
  })
})

describe("请求体访问", () => {
  test("firstUserText 各协议", () => {
    assert.equal(firstUserText({ messages: [{ role: "user", content: "hi" }] }, "chat"), "hi")
    assert.equal(
      firstUserText({ messages: [{ role: "user", content: [{ type: "text", text: "a" }] }] }, "chat"),
      "a",
    )
    assert.equal(firstUserText({ input: "ping" }, "responses"), "ping")
    assert.equal(
      firstUserText({ input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }] }, "responses"),
      "x",
    )
    assert.equal(firstUserText({ contents: [{ role: "user", parts: [{ text: "g" }] }] }, "gemini"), "g")
  })

  test("convKeyOf：metadata 优先，文本兜底", () => {
    const b = { metadata: { user_id: "u__session_abc123" }, messages: [] }
    assert.equal(convKeyOf(b, "anthropic", "p"), "p|m:abc123")
    const b2 = { messages: [{ role: "user", content: "same" }] }
    assert.equal(convKeyOf(b2, "chat", "p"), convKeyOf({ messages: [{ role: "user", content: "same" }] }, "chat", "p"))
    assert.notEqual(convKeyOf(b2, "chat", "p"), convKeyOf({ messages: [{ role: "user", content: "diff" }] }, "chat", "p"))
  })
})

describe("标记注入", () => {
  test("markSystem chat/anthropic/responses/gemini", () => {
    const mk = "[magpie-session:s1]"
    const chat = { messages: [{ role: "user", content: "hi" }] }
    assert.equal(markSystem(chat, "chat", mk), true)
    assert.equal(chat.messages[0].role, "system")
    assert.equal(chat.messages[0].content, mk)

    const chat2 = { messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }
    markSystem(chat2, "chat", mk)
    assert.equal(chat2.messages[0].content, mk + "\n\nbe nice")

    const anth = { messages: [] }
    markSystem(anth, "anthropic", mk)
    assert.equal(anth.system, mk)

    const resp = { input: [] }
    markSystem(resp, "responses", mk)
    assert.equal(resp.instructions, mk)

    const gem = { contents: [] }
    markSystem(gem, "gemini", mk)
    assert.equal(gem.systemInstruction.parts[0].text, mk)
  })

  test("markFirstUser 各协议", () => {
    const mk = "[magpie-session:s1]"
    const chat = { messages: [{ role: "user", content: "hi" }] }
    markFirstUser(chat, "chat", mk)
    assert.equal(chat.messages[0].content, mk + "\n\nhi")

    const resp = { input: "ping" }
    markFirstUser(resp, "responses", mk)
    assert.equal(resp.input, mk + "\n\nping")

    const gem = { contents: [{ role: "user", parts: [{ text: "g" }] }] }
    markFirstUser(gem, "gemini", mk)
    assert.equal(gem.contents[0].parts[0].text, mk + "\n\ng")
  })

  test("stripAllMarks 抹掉旧标记防堆积", () => {
    const mk = "[magpie-session:old1]"
    const chat = {
      messages: [
        { role: "system", content: mk + "\n\nsys" },
        { role: "user", content: mk + "\n\nhi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: mk + "\n\nagain" },
      ],
    }
    stripAllMarks(chat, "chat")
    assert.equal(chat.messages[0].content, "sys")
    assert.equal(chat.messages[1].content, "hi")
    assert.equal(chat.messages[2].content, "ok")
    assert.equal(chat.messages[3].content, "again")
    assert.ok(!JSON.stringify(chat).includes("magpie-session"))
  })

  test("setMetadataSession", () => {
    const b = { metadata: { user_id: "acct__session_old1" }, messages: [] }
    assert.equal(setMetadataSession(b, "new1"), true)
    assert.equal(b.metadata.user_id, "acct__session_new1")
    assert.equal(setMetadataSession({ messages: [] }, "x"), false)
  })

  test("existingMarkSid 从历史恢复", () => {
    const chat = { messages: [{ role: "user", content: "[magpie-session:oldsid1]\n\nhi" }] }
    assert.equal(existingMarkSid(chat, "chat"), "oldsid1")
    const anth = { metadata: { user_id: "u__session_meta12345" }, system: null, messages: [] }
    assert.equal(existingMarkSid(anth, "anthropic"), "meta12345")
    assert.equal(existingMarkSid({ messages: [{ role: "user", content: "plain" }] }, "chat"), null)
  })
})

describe("错误识别", () => {
  test("isLimitError 错误码 / 文本 / 状态码", () => {
    const cfg = readOptions({}).matchCodes
    const full = readOptions({})
    assert.ok(isLimitError(LIMIT_EV, 429, full))
    assert.ok(isLimitError(LIMIT_EV, undefined, full)) // 事件里没有状态码也能靠 code 识别
    assert.equal(isLimitError({ error: { code: "rate_limit" } }, 429, full), false)
    assert.equal(isLimitError({ ok: true }, 200, full), false)
    assert.ok(isLimitError({ error: { message: "Please start a new session to continue" } }, 429, full))
  })

  test("hasErrorField 粗筛", () => {
    assert.ok(hasErrorField({ error: {} }))
    assert.ok(hasErrorField({ choices: [{ error: "x" }] }))
    assert.equal(hasErrorField({ delta: "hi" }), false)
    assert.equal(hasErrorField(null), false)
  })
})

describe("钩子端到端", () => {
  test("未配置的供应商：原样放行", () => {
    reset()
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }
    const out = onProvider(body, mkCtx("other", { providers: {} }))
    assert.equal(out, undefined)
    assert.equal(body.messages.length, 1) // 未被修改
  })

  test("空选项（未保存过）：默认启用 xingchi", () => {
    reset()
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
    const out = onProvider(body, mkCtx("xingchi", {}))
    assert.ok(out) // 无需任何配置就对 xingchi 生效
    assert.ok(out.messages[0].content.startsWith("[magpie-session:"))
  })

  test("启用后注入标记，同对话计数，主动轮换", () => {
    reset()
    const opts = { providers: { xingchi: true }, maxRequests: 3, mark: "both" }
    const mk = (n) => JSON.parse(JSON.stringify({ model: "m", messages: [{ role: "user", content: "same" }] }))
    let lastSid = null
    for (let i = 0; i < 5; i++) {
      const out = onProvider(mk(i), mkCtx("xingchi", opts))
      assert.ok(out && out !== undefined)
      const sid = out.messages[0].content.match(/\[magpie-session:([^\]]+)\]/)[1]
      const sys = out.messages.find((m) => m.role === "system")
      assert.ok(sys.content.startsWith("[magpie-session:"))
      if (i < 3) {
        if (lastSid) assert.equal(sid, lastSid) // 未到阈值：同一会话
        lastSid = sid
      }
    }
    // 第 4、5 次请求超过 maxRequests=3 → 轮换出不同会话标识
    const out5 = onProvider(mk(5), mkCtx("xingchi", opts))
    const sid5 = out5.messages[0].content.match(/\[magpie-session:([^\]]+)\]/)[1]
    assert.notEqual(sid5, lastSid)
  })

  test("anthropic 协议：metadata + 标记同时注入", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const body = {
      model: "claude-x",
      metadata: { user_id: "user__session_orig1" },
      messages: [{ role: "user", content: "hi" }],
    }
    const out = onProvider(body, mkCtx("xingchi", opts, "anthropic"))
    assert.ok(out)
    assert.ok(out.metadata.user_id.startsWith("user__session_"))
    assert.notEqual(out.metadata.user_id, "user__session_orig1")
    assert.ok(out.system.startsWith("[magpie-session:"))
    assert.ok(out.messages[0].content.startsWith("[magpie-session:"))
  })

  test("撞墙检测：onEvent 检出会话上限 → 下次请求换新会话", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const mk = () => JSON.parse(JSON.stringify({ model: "m", messages: [{ role: "user", content: "conv1" }] }))
    const ctx = mkCtx("xingchi", opts)
    const out1 = onProvider(mk(), ctx)
    const sid1 = out1.messages[0].content.match(/\[magpie-session:([^\]]+)\]/)[1]

    // 流里出现会话上限错误事件
    onEvent({ error: { code: "session_request_limit_exceeded" } }, ctx)
    const st = [...state.values()][0]
    assert.ok(st.limitedAt > 0)

    // 下一次请求：换新会话
    const ctx2 = mkCtx("xingchi", opts)
    const out2 = onProvider(mk(), ctx2)
    const sid2 = out2.messages[0].content.match(/\[magpie-session:([^\]]+)\]/)[1]
    assert.notEqual(sid2, sid1)
  })

  test("onResponse 检出非流式错误同样标记撞墙", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const ctx = mkCtx("xingchi", opts)
    onProvider({ model: "m", messages: [{ role: "user", content: "c" }] }, ctx)
    const out = onResponse(JSON.parse(JSON.stringify(LIMIT_EV)), { ...ctx, status: 429 })
    assert.equal(out, undefined) // 不修改回复
    const st = [...state.values()][0]
    assert.ok(st.limitedAt > 0)
  })

  test("重载恢复：请求体里带旧标记时沿用旧会话标识", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    // 模拟中间件重载后（state 清空），对话历史里已有旧标记
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "[magpie-session:oldsid1]\n\nhi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "next" },
      ],
    }
    const out = onProvider(body, mkCtx("xingchi", opts))
    const sid = out.messages[0].content.match(/\[magpie-session:([^\]]+)\]/)[1]
    assert.equal(sid, "oldsid1") // 恢复而不是新开
  })

  test("Responses API：默认 replace——prompt_cache_key 换成轮换值，其余字段不动", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    // Codex 发来的 Responses 请求体，带着它自己的会话 id
    const body = {
      model: "gpt-5.2",
      stream: true,
      prompt_cache_key: "sess_0123456789abcdef",
      instructions: "You are Codex.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "shell" }],
      store: false,
    }
    const out = onProvider(body, mkCtx("xingchi", opts, "responses"))
    assert.ok(out)
    // 旧会话标识被替换成轮换值（uuid 形态），不再包含 Codex 原值
    assert.ok(out.prompt_cache_key !== "sess_0123456789abcdef")
    assert.match(out.prompt_cache_key, /^[0-9a-f-]{36}$/)
    // 与标记里的会话 id 一致
    assert.equal(out.prompt_cache_key, out.instructions.match(/\[magpie-session:([^\]]+)\]/)[1])
    assert.equal(out.model, "gpt-5.2") // 业务字段原样
    assert.equal(out.stream, true)
    assert.deepEqual(out.tools, [{ type: "function", name: "shell" }])
    assert.equal(out.store, false)
    assert.ok(String(out.instructions).endsWith("You are Codex."))
    assert.ok(String(out.input[0].content[0].text).startsWith("[magpie-session:"))
  })

  test("轮换时 prompt_cache_key 跟着换：撞墙后字段值变化", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const mk = () => ({
      model: "m",
      prompt_cache_key: "seed",
      input: [{ role: "user", content: [{ type: "input_text", text: "same-conv" }] }],
    })
    const ctx1 = mkCtx("xingchi", opts, "responses")
    const out1 = onProvider(mk(), ctx1)
    const key1 = out1.prompt_cache_key
    // 撞墙 → 轮换
    onEvent({ error: { code: "session_request_limit_exceeded" } }, ctx1)
    const out2 = onProvider(mk(), mkCtx("xingchi", opts, "responses"))
    assert.notEqual(out2.prompt_cache_key, key1) // 字段值已换新
  })

  test("sessionFields: strip 删除字段（v0.2.0 行为），off 不动", () => {
    reset()
    const stripOpts = { providers: { xingchi: { sessionFields: "strip" } } }
    const body1 = { model: "m", prompt_cache_key: "old", input: "hi" }
    const out1 = onProvider(body1, mkCtx("xingchi", stripOpts, "responses"))
    assert.equal(out1.prompt_cache_key, undefined)
    const offOpts = { providers: { xingchi: { sessionFields: "off" } } }
    const body2 = { model: "m", prompt_cache_key: "keep", input: "hi" }
    const out2 = onProvider(body2, mkCtx("xingchi", offOpts, "responses"))
    assert.equal(out2.prompt_cache_key, "keep") // 原值不动
  })

  test("协议无关改写：chat 协议带 prompt_cache_key 也换成轮换值", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "old1" }
    const out = onProvider(body, mkCtx("xingchi", opts, "chat"))
    assert.ok(out)
    assert.notEqual(out.prompt_cache_key, "old1") // 不依赖 protocol 值
    assert.match(out.prompt_cache_key, /^[0-9a-f-]{36}$/)
  })

  test("session_id 字段也改写为轮换值（strip 模式删除）", () => {
    reset()
    const opts = { providers: { xingchi: true } }
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], session_id: "sess-old1" }
    const out = onProvider(body, mkCtx("xingchi", opts, "chat"))
    assert.notEqual(out.session_id, "sess-old1")
    assert.match(out.session_id, /^[0-9a-f-]{36}$/)
    // strip 模式下删除
    const opts2 = { providers: { xingchi: { sessionFields: "strip" } } }
    const body2 = { model: "m", messages: [{ role: "user", content: "hi2" }], session_id: "sess-keep" }
    const out2 = onProvider(body2, mkCtx("xingchi", opts2, "chat"))
    assert.equal(out2.session_id, undefined)
  })

  test("Responses API：未启用供应商时 prompt_cache_key 原样保留", () => {
    reset()
    const body = { model: "m", input: "hi", prompt_cache_key: "keep-me" }
    const out = onProvider(body, mkCtx("other", { providers: {} }, "responses"))
    assert.equal(out, undefined)
    assert.equal(body.prompt_cache_key, "keep-me") // 未启用：请求体未被修改
  })

  test("Responses API：仅剥离模式（mark=none 且 maxRequests=0）也改写 cache key", () => {
    reset()
    const opts = { providers: { xingchi: { mark: "none", maxRequests: 0 } } }
    const body = { model: "m", input: "hi", prompt_cache_key: "old-session" }
    const out = onProvider(body, mkCtx("xingchi", opts, "responses"))
    assert.ok(out) // 改写后返回修改过的 body
    assert.notEqual(out.prompt_cache_key, "old-session")
    assert.equal(JSON.stringify(out).includes("magpie-session"), false) // 不注入任何标记
  })

  test("异常安全：钩子出错不抛出", () => {
    reset()
    assert.equal(onProvider(null, mkCtx("xingchi", {})), undefined)
    assert.equal(onProvider({ messages: null }, null), undefined)
    assert.equal(onEvent(null, null), undefined)
    assert.equal(onResponse(null, null), undefined)
  })
})

describe("轮次压缩（每会话最多 N 轮）", () => {
  test("chat：超过 maxTurns 只保留最近轮次，保留 system", () => {
    const msgs = [{ role: "system", content: "sys" }]
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "user", content: "u" + i })
      msgs.push({ role: "assistant", content: "a" + i })
    }
    const body = { model: "m", messages: msgs }
    const r = trimTurns(body, "chat", 3)
    assert.ok(r)
    const replies = body.messages.filter((m) => m.role === "assistant").length
    assert.ok(replies <= 3)
    assert.equal(body.messages[0].role, "system") // system 保留
    assert.equal(body.messages[1].role, "user") // 以用户轮开头
    assert.equal(body.messages[body.messages.length - 1].content, "a9") // 最新一轮还在
    assert.ok(r.dropped >= 7)
  })

  test("chat：未超阈值不动", () => {
    const body = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }
    assert.equal(trimTurns(body, "chat", 5), null)
  })

  test("anthropic：不把 tool_result 当轮起点", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "a1" },
        { role: "user", content: "next" },
        { role: "assistant", content: "a2" },
      ],
    }
    const r = trimTurns(body, "anthropic", 1)
    assert.ok(r)
    assert.equal(body.messages[0].content, "next")
    assert.equal(body.messages[1].content, "a2")
  })

  test("responses：function_call 计入轮次，instructions 不受影响", () => {
    const body = {
      instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q0" }] },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c0" },
        { type: "function_call_output", call_id: "c0", output: "ok" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
      ],
    }
    const r = trimTurns(body, "responses", 1)
    assert.ok(r)
    assert.equal(body.instructions, "sys")
    assert.equal(body.input[0].content[0].text, "q1")
    assert.equal(body.input[1].type, "function_call")
  })

  test("gemini：role=model 计轮次", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "u0" }] },
        { role: "model", parts: [{ text: "m0" }] },
        { role: "user", parts: [{ text: "u1" }] },
        { role: "model", parts: [{ text: "m1" }] },
      ],
    }
    const r = trimTurns(body, "gemini", 1)
    assert.ok(r)
    assert.equal(body.contents[0].parts[0].text, "u1")
    assert.equal(body.contents.length, 2)
  })

  test("钩子：超轮次自动压缩并换会话", () => {
    reset()
    const opts = { providers: { xingchi: true }, maxTurns: 2 }
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u0" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
    ]
    const out = onProvider({ model: "m", messages: msgs }, mkCtx("xingchi", opts))
    assert.ok(out)
    const replies = out.messages.filter((m) => m.role === "assistant").length
    assert.ok(replies <= 2)
    const st = [...state.values()][0]
    assert.equal(st.count, 1) // 压缩后计为新会话
  })

  test("已撞墙的真实场景：Codex 带 105 轮历史 + 旧会话 id，一次请求即降到上限内", () => {
    reset()
    const opts = { providers: { xingchi: true } } // 全部默认（maxTurns=80）
    const input = []
    for (let i = 0; i < 105; i++) {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "q" + i }] })
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "a" + i }] })
    }
    const body = {
      model: "gpt-6.1-sol",
      stream: true,
      prompt_cache_key: "sess_deadbeefdeadbeef",
      instructions: "You are Codex.",
      input,
      tools: [{ type: "function", name: "shell" }],
      store: false,
    }
    const out = onProvider(body, mkCtx("xingchi", opts, "responses"))
    assert.ok(out)
    const replies = out.input.filter((m) => m.role === "assistant" || m.type === "function_call").length
    assert.ok(replies <= 80, "压缩后轮数必须 <= maxTurns，实际 " + replies)
    assert.notEqual(out.prompt_cache_key, "sess_deadbeefdeadbeef") // 会话 id 已换
    assert.equal(out.instructions.indexOf("You are Codex.") >= 0, true) // 指令保留
    assert.deepEqual(out.tools, [{ type: "function", name: "shell" }])
  })

  test("maxTurns=0 关闭压缩", () => {
    const body = { messages: [] }
    for (let i = 0; i < 10; i++) {
      body.messages.push({ role: "assistant", content: "a" + i })
      body.messages.push({ role: "user", content: "u" + i })
    }
    assert.equal(trimTurns(body, "chat", 0), null)
  })
})
