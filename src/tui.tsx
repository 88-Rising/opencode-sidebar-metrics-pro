import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"

interface ContentItem {
  type: string
  time?: { created?: number; completed?: number }
}

interface SessionLikeMessage {
  type: string
  summary?: boolean
  time: { created: number; completed?: number }
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  content?: ReadonlyArray<ContentItem>
}

interface Metrics {
  /** 平均每秒生成速度（output + reasoning tokens / 累计生成时长） */
  tps?: number
  /** 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite) */
  cacheHit?: number
  /** 平均首 token 返回时延（TTFT：最早 content 起始时间 − 消息创建时间） */
  ttft?: number
}

/**
 * 单条消息的首 token 时延（毫秒）。
 * 消息 `time.created` 是请求发出时刻，`content` 中最早一项的 `time.created`
 * 是首个 token（reasoning/text）开始落盘的时刻，二者之差即该轮的 TTFT。
 * 尚未产出任何 content 的消息返回 undefined。
 * streaming 中（无 time.completed）的消息返回 undefined，避免中间值闪烁。
 */
function messageTtft(message: SessionLikeMessage): number | undefined {
  if (message.summary) return undefined
  if (message.time.completed === undefined) return undefined
  let first: number | undefined
  for (const item of message.content ?? []) {
    const created = item.time?.created
    if (typeof created !== "number") continue
    if (first === undefined || created < first) first = created
  }
  if (first === undefined) return undefined
  const delay = first - message.time.created
  return delay > 0 ? delay : undefined
}

/**
 * 有限数值归一：非有限（undefined/null/NaN/Infinity/非数字）一律按 0 处理，
 * 所有 token 求和点统一经此守卫，避免脏数据污染累计值。
 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function computeMetrics(messages: readonly SessionLikeMessage[]): Metrics {
  let generated = 0
  let elapsedMs = 0
  let freshInput = 0
  let cacheRead = 0
  let cacheWrite = 0
  let ttftTotal = 0
  let ttftCount = 0

  for (const message of messages) {
    if (!message || message.type !== "assistant") continue
    if (message.summary) continue

    // 仅统计 completed 消息的 TTFT：streaming 中间值不计，防闪烁
    if (message.time?.completed !== undefined) {
      const ttft = messageTtft(message)
      if (ttft !== undefined) {
        ttftTotal += ttft
        ttftCount += 1
      }
    }

    const tokens = message.tokens
    if (!tokens) continue
    freshInput += num(tokens.input)
    cacheRead += num(tokens.cache?.read)
    cacheWrite += num(tokens.cache?.write)

    // 速度累计要求 created/completed 双双有限，否则跳过该消息
    const created = message.time?.created
    const completed = message.time?.completed
    if (typeof created !== "number" || !Number.isFinite(created)) continue
    if (typeof completed !== "number" || !Number.isFinite(completed)) continue
    const elapsed = completed - created
    if (!(elapsed > 0) || !Number.isFinite(elapsed)) continue
    generated += num(tokens.output) + num(tokens.reasoning)
    elapsedMs += elapsed
  }

  const metrics: Metrics = {}
  if (generated > 0 && elapsedMs > 0) {
    metrics.tps = generated / (elapsedMs / 1000)
  }
  const totalInput = freshInput + cacheRead + cacheWrite
  if (totalInput > 0) {
    metrics.cacheHit = cacheRead / totalInput
  }
  if (ttftCount > 0) {
    metrics.ttft = ttftTotal / ttftCount
  }
  return metrics
}

function formatDelay(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 子代理 rollup 的消息来源：开关开时用 session.family(sessionID) 找同 family
 * 会话并与其 completed assistant 消息合并，跑同一 computeMetrics/ioTotals 口径；
 * 开关关时仅主会话。family 不可用/抛错时降级为仅主会话。
 */
function getRollupMessages(data: any, sessionID: string, includeSubagents: boolean): readonly SessionLikeMessage[] {
  let raw: unknown
  try {
    raw = data.session.message.list(sessionID)
  } catch (error) {
    console.warn("[metrics-pro] session.message.list failed, using empty rollup", error)
    return []
  }
  const main: readonly SessionLikeMessage[] = Array.isArray(raw) ? raw : []
  if (!includeSubagents) return main
  let family: unknown
  try {
    family = data.session.family(sessionID) ?? []
  } catch {
    // family 不可用时静默降级为仅主会话：子代理聚合是增强功能，不刷屏
    return main
  }
  if (!Array.isArray(family) || family.length === 0) return main
  const merged: SessionLikeMessage[] = [...main]
  const seen = new Set<string>([sessionID])
  for (const childID of family) {
    if (seen.has(childID)) continue
    seen.add(childID)
    try {
      const child: unknown = data.session.message.list(childID)
      if (!Array.isArray(child)) continue
      for (const message of child) merged.push(message)
    } catch {
      // 单个子会话不可读时静默跳过：不影响主会话指标，不刷屏
    }
  }
  return merged
}

/**
 * 会话已用时长：<60m 显示 `Xm`，>=60m 显示 `XhYYm`（如 1h05m），分钟向下取整。
 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalMinutes = Math.floor(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h${String(minutes).padStart(2, "0")}m`
}

/**
 * 主题色防御式读取：兼容新旧两种主题结构（扁平 RGBA / 嵌套分组），逐级 fallback 到 text，绝不 crash。
 * 旧主题：theme.text / theme.textMuted / theme.accent / theme.success / theme.warning / theme.error
 * 新主题：theme.text.base / theme.text.muted / theme.accent.base / theme.success.base ……
 */
function asThemeColor(value: unknown): any {
  try {
    if (value === undefined || value === null) return undefined
    if (typeof value === "string") return value
    if (typeof value === "object") {
      const o = value as any
      if (o.buffer !== undefined) return value
      if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") return value
    }
    return undefined
  } catch {
    return undefined
  }
}

function themeText(theme: unknown): any {
  try {
    const t = theme as any
    return asThemeColor(t?.text?.base) ?? asThemeColor(t?.text) ?? undefined
  } catch {
    return undefined
  }
}

function themeMuted(theme: unknown): any {
  try {
    const t = theme as any
    return (
      asThemeColor(t?.text?.muted) ??
      asThemeColor(t?.textMuted) ??
      asThemeColor(t?.text?.base) ??
      asThemeColor(t?.text) ??
      undefined
    )
  } catch {
    return undefined
  }
}

interface LastRound {
  tps?: number
  ttft?: number
  elapsedMs?: number
}

/** 输入/输出拆分：遍历 completed assistant 消息累加 input（In）与 output+reasoning（Out）。 */
function computeIoTotals(messages: readonly SessionLikeMessage[]): {
  inTokens: number
  outTokens: number
  hasCompleted: boolean
} {
  let inTokens = 0
  let outTokens = 0
  let hasCompleted = false
  for (const message of messages) {
    if (!message || message.type !== "assistant") continue
    if (message.summary) continue
    const created = message.time?.created
    const completed = message.time?.completed
    if (typeof created !== "number" || !Number.isFinite(created)) continue
    if (typeof completed !== "number" || !Number.isFinite(completed)) continue
    hasCompleted = true
    const tokens = message.tokens
    if (!tokens) continue
    inTokens += num(tokens.input)
    outTokens += num(tokens.output) + num(tokens.reasoning)
  }
  return { inTokens, outTokens, hasCompleted }
}

/** 最近一轮：最后一条 completed assistant 消息单独算。 */
function computeLastRound(messages: readonly SessionLikeMessage[]): LastRound {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== "assistant") continue
    if (message.summary) continue
    const created = message.time?.created
    const completed = message.time?.completed
    if (typeof created !== "number" || !Number.isFinite(created)) continue
    if (typeof completed !== "number" || !Number.isFinite(completed)) continue
    let tps: number | undefined
    let elapsedMs: number | undefined
    try {
      const elapsed = completed - created
      if (elapsed > 0 && Number.isFinite(elapsed)) {
        elapsedMs = elapsed
        const tokens = message.tokens
        if (tokens) {
          const generated = num(tokens.output) + num(tokens.reasoning)
          const value = generated / (elapsed / 1000)
          tps = Number.isFinite(value) ? value : undefined
        }
      }
    } catch {
      tps = undefined
    }
    let ttft: number | undefined
    try {
      ttft = messageTtft(message)
    } catch {
      ttft = undefined
    }
    return { tps, ttft, elapsedMs }
  }
  return {}
}

/**
 * 金额格式：0 显示 `$0.00`，0<x<0.01 显示 `<$0.01`，其余 `$X.XX`（toFixed(2)）。
 */
function formatCost(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "$0.00"
  if (value < 0.01) return "<$0.01"
  return `$${value.toFixed(2)}`
}

/**
 * 单个会话花费（number；无数据时 undefined）：
 * 优先 `data.session.cost(sessionID)`，其次 `session.get(sessionID)?.cost`，
 * 都不可用时回退累加该会话 assistant 消息的 cost 多候选
 *（`cost ?? info.cost ?? usage.cost`，仅正数计入；无正数则视为无数据）。
 */
function sessionCost(data: any, sessionID: string): number | undefined {
  try {
    if (typeof data?.session?.cost === "function") {
      const value: unknown = data.session.cost(sessionID)
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
    }
  } catch {
    // 降级到下一口径
  }
  try {
    if (typeof data?.session?.get === "function") {
      const info = data.session.get(sessionID) as { cost?: unknown } | undefined
      const value: unknown = (info as { cost?: unknown } | undefined)?.cost
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
    }
  } catch {
    // 降级到下一口径
  }
  try {
    if (typeof data?.session?.message?.list !== "function") return undefined
    const raw: unknown = data.session.message.list(sessionID)
    if (!Array.isArray(raw)) return undefined
    let sum = 0
    let found = false
    for (const item of raw) {
      const message = item as {
        type?: unknown
        summary?: unknown
        cost?: unknown
        info?: { cost?: unknown }
        usage?: { cost?: unknown }
      } | null
      if (!message || message.type !== "assistant") continue
      if (message.summary) continue
      const candidate: unknown = message.cost ?? message.info?.cost ?? message.usage?.cost
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
        sum += candidate
        found = true
      }
    }
    return found ? sum : undefined
  } catch {
    return undefined
  }
}

/**
 * 子代理花费：`family(mainID)` 去重（排除主会话自身）后每个 child 按
 * sessionCost 口径求和；任一 child 有有效值时返回总和，全无有效值时返回
 * undefined；family 抛错/不可用/为空时返回 0（调用方仍渲染该行）。
 */
function subagentCost(data: any, mainID: string): number | undefined {
  let family: unknown
  try {
    if (typeof data?.session?.family !== "function") return 0
    family = data.session.family(mainID)
  } catch {
    return 0
  }
  if (!Array.isArray(family) || family.length === 0) return 0
  let sum = 0
  let found = false
  const seen = new Set<string>([mainID])
  for (const childID of family) {
    if (typeof childID !== "string" || childID.length === 0) continue
    if (seen.has(childID)) continue
    seen.add(childID)
    try {
      const value = sessionCost(data, childID)
      if (value !== undefined) {
        sum += value
        found = true
      }
    } catch {
      // 单个子会话不可读时跳过
    }
  }
  return found ? sum : undefined
}

/**
 * 会改变 `session.message.list()` 内容或本插件所读字段的事件（裁剪后 7 个）。
 *
 * 宿主在这些事件中会自动同步消息缓存，事件里只 bump revision 信任宿主节拍，
 * 不再手动 `sync`。仅挂载时主动 `sync` 一次兜底：新窗口打开时历史消息可能尚未拉取。
 */
const REFRESH_EVENTS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.step.ended",
  "session.text.ended",
  "session.reasoning.ended",
  "session.usage.updated",
  "session.compaction.ended",
] as const

function TokenMetrics(props: { sessionID: () => string; expanded: () => boolean; toggle: () => void; includeSubagents: () => boolean }) {
  const context = usePlugin()
  const [revision, setRevision] = createSignal(0)
  const expanded = () => props.expanded()

  createEffect(() => {
    const sessionID = props.sessionID()
    const bump = () => setRevision((value) => value + 1)

    // 新窗口打开时历史消息尚未进入缓存，先主动拉一次；之后信任宿主在事件中的自动同步
    try {
      context.data.session.message.sync(sessionID).then(bump, bump)
    } catch (error) {
      console.warn("[metrics-pro] initial message sync failed", error)
    }

    let offs: Array<() => void> = []
    try {
      offs = REFRESH_EVENTS.map((type) =>
        context.data.on(type, (event) => {
          // 事件负载的 sessionID 在 data 下，不在顶层；宿主已同步缓存，这里只 bump revision
          if (event?.data?.sessionID === sessionID) bump()
        }),
      )
    } catch (error) {
      console.warn("[metrics-pro] event subscribe failed", error)
    }
    onCleanup(() => {
      for (const off of offs) off()
    })
  })

  // 共享快照：getRollupMessages（含子代理 rollup）供 metrics/ioTotals 两处复用；
  // 依赖 revision/sessionID/includeSubagents。Last 行恒只读主会话，另行轻 memo。
  const rollup = createMemo((): readonly SessionLikeMessage[] => {
    revision()
    const sid = props.sessionID()
    const include = props.includeSubagents()
    try {
      return getRollupMessages(context.data, sid, include)
    } catch {
      return []
    }
  })

  // 指纹：messages.length + 最后一条 completed 消息的 time.completed + 全量 token 摘要，
  // usage.updated 只改 tokens 不改 time.completed 时也能命中重算，避免 memo 短路漏更新。
  // 指纹命中时 metrics/ioTotals 两处直接复用上次结果对象（引用稳定，避免下游重渲染
  // 且不再重扫）；未命中时两处由同一快照一次算出。
  let fingerprint: string | undefined = undefined
  let cachedMetrics: Metrics = {}
  let cachedIO = { inTokens: 0, outTokens: 0, hasCompleted: false }
  const snapshot = createMemo(() => {
    const messages = rollup()
    let lastCompleted = "none"
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const completed = messages[index]?.time?.completed
      if (typeof completed === "number" && Number.isFinite(completed)) {
        lastCompleted = String(completed)
        break
      }
    }
    let tokenSum = 0
    for (const message of messages) {
      if (message?.summary) continue
      const tokens = message?.tokens
      if (!tokens) continue
      tokenSum += num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(tokens.cache?.read) + num(tokens.cache?.write)
    }
    const next = `${messages.length}:${lastCompleted}:${tokenSum}`
    if (next === fingerprint) return { metrics: cachedMetrics, io: cachedIO }
    const freshMetrics = computeMetrics(messages)
    const freshIO = computeIoTotals(messages)
    fingerprint = next
    cachedMetrics = freshMetrics
    cachedIO = freshIO
    return { metrics: freshMetrics, io: freshIO }
  })

  const metrics = createMemo((): Metrics => {
    try {
      return snapshot().metrics
    } catch {
      return cachedMetrics
    }
  })

  const m = () => metrics()

  // 最近一轮恒只读主会话、不受 +sub 开关影响：单独轻 memo，只依赖 revision/sessionID。
  const lastRound = createMemo((): LastRound => {
    revision()
    const sid = props.sessionID()
    try {
      return computeLastRound(getRollupMessages(context.data, sid, false))
    } catch {
      return {}
    }
  })

  const labelFg = () => themeText(context.theme)
  const mutedFg = () => themeMuted(context.theme)

  // 输入/输出拆分：复用上面的同一快照/指纹，不再各自重扫。
  const ioTotals = createMemo(() => {
    try {
      return snapshot().io
    } catch {
      return cachedIO
    }
  })

  // Spent 拆分：仅 +sub 开启时计算。主会话按 sessionCost 口径，子代理按
  // subagentCost 口径（family 求和）；revision 驱动，随 usage 更新刷新。
  const spent = createMemo((): { main: number | undefined; sub: number | undefined } => {
    revision()
    if (!props.includeSubagents()) return { main: undefined, sub: undefined }
    const sid = props.sessionID()
    let main: number | undefined
    try {
      main = sessionCost(context.data, sid)
    } catch {
      main = undefined
    }
    let sub: number | undefined
    try {
      sub = subagentCost(context.data, sid)
    } catch {
      sub = 0
    }
    return { main, sub }
  })

  return (
    <box flexDirection="column">
      <text onMouseDown={() => props.toggle()}>
        <b>Metrics Pro</b>
        {(() => {
          return props.includeSubagents() ? <span style={{ fg: mutedFg() }}>{" +sub"}</span> : null
        })()}
        <b> {expanded() ? "▼" : "▶"}</b>
      </text>
      {expanded() ? (
        <text>
          <span style={{ fg: labelFg() }}>Speed </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const v = m().tps
              return v !== undefined ? `${v.toFixed(1)} tokens/s` : "-"
            })()}
          </span>
        </text>
      ) : null}
      {expanded() ? (
        <text>
          <span style={{ fg: labelFg() }}>Cache </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const v = m().cacheHit
              return v !== undefined ? `${Math.round(v * 100)}%` : "-"
            })()}
          </span>
        </text>
      ) : null}
      {expanded() ? (
        <text>
          <span style={{ fg: labelFg() }}>TTFT </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const v = m().ttft
              return v !== undefined ? formatDelay(v) : "-"
            })()}
          </span>
        </text>
      ) : null}
      {expanded() ? (
        <text>
          <span style={{ fg: labelFg() }}>In </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const io = ioTotals()
              return io.hasCompleted ? io.inTokens.toLocaleString("en-US") : "-"
            })()}
          </span>
          <span style={{ fg: labelFg() }}> · Out </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const io = ioTotals()
              return io.hasCompleted ? `${io.outTokens.toLocaleString("en-US")} tokens` : "- tokens"
            })()}
          </span>
        </text>
      ) : null}
      {expanded() && props.includeSubagents() ? (
        <text>
          <span style={{ fg: labelFg() }}>Spent </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const v = spent().main
              return v !== undefined ? formatCost(v) : "-"
            })()}
          </span>
          <span style={{ fg: labelFg() }}> · sub </span>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const v = spent().sub
              return v !== undefined ? formatCost(v) : "-"
            })()}
          </span>
        </text>
      ) : null}
      {expanded() ? (
        <text>
          <span style={{ fg: mutedFg() }}>
            {(() => {
              const last = lastRound()
              const tps = last.tps !== undefined && last.tps > 0 ? `${last.tps.toFixed(1)} tokens/s` : "-"
              const ttft = last.ttft !== undefined ? formatDelay(last.ttft) : "-"
              const elapsed = last.elapsedMs !== undefined ? ` · ${Math.round(last.elapsedMs / 1000)}s` : ""
              return `Last ${tps} · ${ttft}${elapsed}`
            })()}
          </span>
        </text>
      ) : null}
    </box>
  )
}

/**
 * 底部 footer 单行：`12.4 tokens/s · 87% · 2.7s · 24m`（Speed · Cache · TTFT · 会话已用时长）。
 * 紧凑无标题、muted 色；有值显示值、无值显示 -。
 * 会话创建时间取 `session.get(sessionID).time.created`，缺失时回退到最早一条消息的
 * `time.created`，都没有时整段（含前面的 · 分隔符）不渲染。
 * 数据走共用的 computeMetrics（各自 memo，不复制计算）；订阅复用 sidebar
 * 同一套事件常量，事件里只 bump revision 信任宿主节拍，
 * 不碰 TokenMetrics 的显示/折叠记忆/事件/指纹逻辑。
 */
function FooterStatus(props: { sessionID: () => string | undefined; includeSubagents: () => boolean }) {
  const context = usePlugin()
  const [revision, setRevision] = createSignal(0)
  const sessionID = () => props.sessionID()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30000)
  onCleanup(() => clearInterval(timer))

  createEffect(() => {
    const id = sessionID()
    if (id === undefined) return
    const bump = () => setRevision((value) => value + 1)

    // 主动拉一次兜底新窗口历史，之后靠事件 bump 信任宿主自动同步
    try {
      context.data.session.message.sync(id).then(bump, bump)
    } catch (error) {
      console.warn("[metrics-pro] footer initial message sync failed", error)
    }

    let offs: Array<() => void> = []
    try {
      offs = REFRESH_EVENTS.map((type) =>
        context.data.on(type, (event) => {
          // 事件负载的 sessionID 在 data 下，不在顶层；宿主已同步缓存，这里只 bump revision
          if (event?.data?.sessionID === id) bump()
        }),
      )
    } catch (error) {
      console.warn("[metrics-pro] footer event subscribe failed", error)
    }
    onCleanup(() => {
      for (const off of offs) off()
    })
  })

  const metrics = createMemo((): Metrics => {
    revision()
    const id = sessionID()
    if (id === undefined) return {}
    try {
      const messages = getRollupMessages(context.data, id, props.includeSubagents())
      return computeMetrics(messages)
    } catch {
      return {}
    }
  })

  const mutedFg = () => themeMuted(context.theme)

  // 会话创建时间：优先 session.get(sessionID).time.created，
  // 缺失时回退到最早一条消息的 time.created，都没有则返回 undefined。
  const createdAt = createMemo((): number | undefined => {
    revision()
    const id = sessionID()
    if (id === undefined) return undefined
    try {
      const info = context.data.session.get(id) as unknown as { time?: { created?: unknown } } | undefined
      const created = (info as { time?: { created?: unknown } } | undefined)?.time?.created
      if (typeof created === "number" && Number.isFinite(created)) return created
    } catch (error) {
      console.warn("[metrics-pro] session.get failed, falling back to message time", error)
    }
    try {
      const messages = context.data.session.message.list(id) as readonly SessionLikeMessage[]
      let first: number | undefined
      for (const message of messages) {
        const created = message?.time?.created
        if (typeof created === "number" && Number.isFinite(created)) {
          if (first === undefined || created < first) first = created
        }
      }
      if (first !== undefined) return first
    } catch (error) {
      console.warn("[metrics-pro] message list for createdAt failed", error)
    }
    return undefined
  })

  const line = () => {
    const m = metrics()
    const tps = m.tps !== undefined ? `${m.tps.toFixed(1)} tokens/s` : "-"
    const cache = m.cacheHit !== undefined ? `${Math.round(m.cacheHit * 100)}%` : "-"
    const ttft = m.ttft !== undefined ? formatDelay(m.ttft) : "-"
    const base = `${tps} · ${cache} · ${ttft}`
    const created = createdAt()
    if (created === undefined) return base
    const elapsed = now() - created
    if (!Number.isFinite(elapsed) || elapsed < 0) return base
    return `${base} · ${formatElapsed(elapsed)}`
  }

  // 无 session（如 home 路由且 slot.sessionID 缺失）时不渲染，避免显示 stale 旧会话。
  if (sessionID() === undefined) return null

  return (
    <text>
      <span style={{ fg: mutedFg() }}>{line()}</span>
    </text>
  )
}

export default Plugin.define({
  id: "opencode-sidebar-metrics-pro",
  setup(context) {
    const [ui, updateUi] = context.storage.memory("ui", { initial: { expanded: true, includeSubagents: false } })
    // 旧 store 可能缺字段，读时归一：expanded 缺失默认 true，includeSubagents 缺失默认 false
    const expanded = () => ui.expanded ?? true
    const toggle = () => updateUi((draft) => {
      draft.expanded = !draft.expanded
    })
    const includeSubagents = () => ui.includeSubagents ?? false
    const toggleSubagents = () => updateUi((draft) => {
      draft.includeSubagents = !draft.includeSubagents
    })
    const offApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "metrics-pro.toggle",
              title: "Toggle Metrics Pro panel",
              group: "Metrics Pro",
              palette: true,
              slash: { name: "metrics-pro" },
              run: () => toggle(),
            },
            {
              id: "metrics-pro.subagents",
              title: "Toggle subagent rollup",
              group: "Metrics Pro",
              palette: true,
              slash: { name: "metrics-pro-subagents" },
              run: () => toggleSubagents(),
            },
          ],
        }))
        return null
      },
    })
    // prompt.footer.status 的 sessionID 缺失时（如 home 路由）返回 null，不再回退旧 sidebar
    // 会话，避免 footer 显示 stale 数据。
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (slot) => {
        return <TokenMetrics sessionID={() => slot.sessionID} expanded={expanded} toggle={toggle} includeSubagents={includeSubagents} />
      },
    })
    const offFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (slot) => {
        const id = slot.sessionID
        if (id === undefined) return null
        return <FooterStatus sessionID={() => id} includeSubagents={includeSubagents} />
      },
    })
    return () => {
      offApp()
      offSidebar()
      offFooter()
    }
  },
})
