<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'

// 输入框与 DOM 引用。
const input = ref('')
const inputRef = ref(null)
const messageListRef = ref(null)
const autoScrollEnabled = ref(true)
const isProgrammaticScroll = ref(false)
const lastScrollTop = ref(0)

// 聊天消息状态。
const messages = ref([])
const loading = ref(false)
const fetching = ref(false)
const generating = ref(false)
const canContinue = ref(false)
const requestElapsed = ref(0)

// 会话与侧边栏状态。
const conversationId = ref(null)
const conversations = ref([])
const switchingConversation = ref(false)
const drawerOpen = ref(false)
// 删除会话确认弹窗状态。
const deleteModalOpen = ref(false)
const pendingDeleteConversationId = ref(null)

// 接口与本地缓存键。
const API_BASE = 'http://127.0.0.1:8000'
const STORAGE_KEY = 'ai-chat-conversation-id'
const SYSTEM_PROMPT_KEY = 'ai-chat-system-prompt'
const SYSTEM_PROMPT_PRESET_KEY = 'ai-chat-system-prompt-preset'
const systemPrompt = ref(localStorage.getItem(SYSTEM_PROMPT_KEY) || '')
const CUSTOM_PRESET_KEY = 'custom'
const systemPromptPresets = [
  {
    key: 'general',
    label: '通用助手',
    prompt: '你是一个通用 AI 助手。请用中文回答，表达清晰、简洁，优先给出可执行建议。'
  },
  {
    key: 'coding',
    label: '编程助手',
    prompt:
      '你是一名资深编程助手。请用中文回答，先给可运行方案，再补充关键原理与边界条件，代码尽量简洁。'
  },
  {
    key: 'interview',
    label: '面试助手',
    prompt:
      '你是一名面试助手。请用中文回答，按“思路-要点-示例”结构给出答案，突出重点并提供可复述的表达。'
  },
  {
    key: 'translation',
    label: '翻译助手',
    prompt: '你是一名翻译助手。请准确翻译并保留原意与语气；如有歧义，给出更自然的候选译法。'
  }
]
const systemPromptPreset = ref(localStorage.getItem(SYSTEM_PROMPT_PRESET_KEY) || 'general')

const findPresetByKey = (key) => systemPromptPresets.find((item) => item.key === key)
const matchPresetByPrompt = (value) => {
  // 统一做 trim，避免前后空白导致预设匹配失败。
  const normalized = (value || '').trim()
  if (!normalized) return null
  return systemPromptPresets.find((item) => item.prompt === normalized) || null
}
const applySystemPromptPreset = (key) => {
  // 根据 key 应用预设内容到系统提示词输入框。
  const preset = findPresetByKey(key)
  if (!preset) return
  systemPrompt.value = preset.prompt
}

const matchedPreset = matchPresetByPrompt(systemPrompt.value)
if (matchedPreset) {
  systemPromptPreset.value = matchedPreset.key
} else if (!systemPrompt.value.trim()) {
  applySystemPromptPreset(systemPromptPreset.value)
} else {
  systemPromptPreset.value = CUSTOM_PRESET_KEY
}

// 请求耗时计时器句柄。
let requestTimer = null
let streamAbortController = null
const abortRequested = ref(false)

// Markdown 渲染配置。
marked.setOptions({ gfm: true, breaks: true })
watch(systemPrompt, (value) => {
  localStorage.setItem(SYSTEM_PROMPT_KEY, value)
  const matched = matchPresetByPrompt(value)
  systemPromptPreset.value = matched ? matched.key : CUSTOM_PRESET_KEY
})
watch(systemPromptPreset, (value) => {
  localStorage.setItem(SYSTEM_PROMPT_PRESET_KEY, value)
})

// 派生 UI 状态。
const canSend = computed(() => input.value.trim().length > 0 && !loading.value)
const sendButtonText = computed(() => (generating.value ? '中止' : '发送'))
const continueButtonText = computed(() => (generating.value ? '正在续写...' : '继续生成'))
const elapsedText = computed(() => `${requestElapsed.value.toFixed(1)} 秒`)
const isBusy = computed(() => loading.value || switchingConversation.value)

// 滚动到底部。force=true 时忽略自动滚动开关。
const scrollToBottom = (force = false) => {
  // 在允许自动滚动时，把消息列表滚动到最底部。
  const el = messageListRef.value
  if (!el) return
  if (!force && !autoScrollEnabled.value) return
  isProgrammaticScroll.value = true
  el.scrollTop = el.scrollHeight + 1000
  requestAnimationFrame(() => {
    const target = messageListRef.value
    if (!target) return
    lastScrollTop.value = target.scrollTop
    isProgrammaticScroll.value = false
  })
}

// 监听消息区滚动，控制是否自动跟随到底部。
const handleMessagesScroll = () => {
  // 根据用户滚动方向动态开关自动跟随。
  const el = messageListRef.value
  if (!el) return
  if (isProgrammaticScroll.value) return

  const currentTop = el.scrollTop
  const scrollingUp = currentTop < lastScrollTop.value
  lastScrollTop.value = currentTop

  // 用户只要向上滚动，就锁定自动滚动，避免抖动和回拉。
  if (scrollingUp) {
    autoScrollEnabled.value = false
    return
  }

  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  // 仅在非常接近底部时恢复自动滚动（带滞回，避免抖动）。
  if (!autoScrollEnabled.value && distanceToBottom <= 16) {
    autoScrollEnabled.value = true
    return
  }
  if (autoScrollEnabled.value && distanceToBottom > 120) {
    autoScrollEnabled.value = false
  }
}

// 根据内容自动调整输入框高度。
const resizeTextarea = () => {
  // 输入时自适应高度，限制最大高度避免遮挡页面。
  const el = inputRef.value
  if (!el) return
  el.style.height = '24px'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

// 发送后重置输入框高度。
const resetTextarea = () => {
  // 发送后恢复输入框默认高度。
  const el = inputRef.value
  if (!el) return
  el.style.height = '24px'
}

// 开始请求耗时计时。
const startRequestTimer = () => {
  // 记录本次请求耗时，用于展示等待时长。
  requestElapsed.value = 0
  if (requestTimer) clearInterval(requestTimer)
  const startAt = Date.now()
  requestTimer = setInterval(() => {
    requestElapsed.value = (Date.now() - startAt) / 1000
  }, 100)
}

// 停止请求耗时计时。
const stopRequestTimer = () => {
  // 结束计时，避免重复定时器占用资源。
  if (!requestTimer) return
  clearInterval(requestTimer)
  requestTimer = null
}

// 统一把任意类型内容转为可展示字符串。
const normalizeAssistantText = (value) => {
  // 把任意类型的返回统一转为可展示字符串。
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// Markdown 转 HTML。
const unwrapPseudoMarkdownFence = (value) => {
  // 去掉 markdown/text 伪代码围栏，减少前端渲染噪音。
  const text = normalizeAssistantText(value)
  const normalized = text.replace(/\r\n?/g, '\n')
  const nonCodeLangs = new Set(['', 'markdown', 'md', 'mdown', 'mkd', 'text', 'txt', 'plain', 'plaintext'])
  const likelyCode = (body) =>
    // 通过关键字与语法符号判断文本是否更像代码。
    /(^|\n)\s{0,3}(const|let|var|function|class|import|export|if|for|while|return|def|public|private)\b|=>|[;{}()]|<\/?[a-z][^>]*>/i.test(
      body
    )
  const shouldUnwrap = (lang, body) => {
    // 仅对 markdown/text 类围栏做解包处理。
    const normalizedLang = (lang || '').trim().toLowerCase()
    if (!nonCodeLangs.has(normalizedLang)) return false
    if (normalizedLang) return true
    return !likelyCode(body)
  }

  return normalized.replace(/```([^\n`]*)\n([\s\S]*?)\n```/g, (raw, lang, body) => {
    if (!shouldUnwrap(lang, body)) return raw
    return body.trimEnd()
  })
}

const renderMarkdown = (value) => marked.parse(unwrapPseudoMarkdownFence(value))

const findLastAssistantIndex = () => {
  // 从尾部向前查找最后一条 assistant 消息索引。
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i]?.role === 'assistant') return i
  }
  return -1
}

const appendWithoutOverlap = (baseText, incomingText) => {
  // 合并增量文本并处理重叠片段，防止内容重复。
  const base = normalizeAssistantText(baseText)
  const incoming = normalizeAssistantText(incomingText)
  if (!incoming) return base
  if (!base) return incoming

  const maxOverlap = Math.min(base.length, incoming.length, 120)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.endsWith(incoming.slice(0, size))) {
      return base + incoming.slice(size)
    }
  }
  return base + incoming
}

// 生成侧边栏预览文案。
const previewText = (value, fallback) => {
  // 生成会话摘要预览，长度超限时做省略。
  const text = normalizeAssistantText(value).replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 32 ? `${text.slice(0, 32)}...` : text
}

// 会话标题：优先 title，其次最近消息摘要。
const conversationTitle = (item) => {
  // 优先使用显式标题，否则退化为最后一条消息摘要。
  if (item.title && String(item.title).trim()) {
    return previewText(item.title, `会话 #${item.id}`)
  }
  return previewText(item.last_message, `会话 #${item.id}`)
}

// 会话时间信息格式化。
const conversationMeta = (item) => {
  // 会话副标题显示最后消息时间或创建时间。
  if (item.last_message_at) {
    return String(item.last_message_at).replace('T', ' ').slice(0, 16)
  }
  if (item.created_at) {
    return String(item.created_at).replace('T', ' ').slice(0, 16)
  }
  return '暂无消息'
}

// 解析 SSE 缓冲，提取完整 data 事件。
const parseSseEvents = (buffer) => {
  // 从 SSE 缓冲区中提取完整 data 事件，并返回剩余半包。
  const events = []
  let rest = buffer

  while (true) {
    const index = rest.indexOf('\n\n')
    if (index < 0) break

    const raw = rest.slice(0, index)
    rest = rest.slice(index + 2)
    const eventText = raw.replace(/\r/g, '').trim()
    if (!eventText) continue

    const data = eventText
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue

    try {
      events.push(JSON.parse(data))
    } catch {
      // 忽略格式异常片段。
    }
  }

  return { events, rest }
}

// 保存当前会话 ID（内存 + localStorage）。
const saveConversationId = (id) => {
  // 同步保存会话 ID 到内存与本地缓存。
  if (!id) return
  conversationId.value = id
  localStorage.setItem(STORAGE_KEY, String(id))
}

// 拉取会话列表。
const refreshConversationList = async () => {
  // 拉取会话列表，供侧边栏展示。
  const res = await fetch(`${API_BASE}/conversations`)
  if (!res.ok) throw new Error(`加载会话列表失败：HTTP ${res.status}`)
  const data = await res.json()
  conversations.value = data.conversations || []
}

// 用后端消息重建前端消息列表。
const hydrateMessages = (items) => {
  // 用后端消息重建前端消息数组。
  messages.value = (items || []).map((item) => ({
    role: item.role,
    content: item.content
  }))
  canContinue.value = false
}

// 加载指定会话。
const loadConversation = async (id) => {
  // 加载指定会话消息并设为当前会话。
  const res = await fetch(`${API_BASE}/conversations/${id}/messages`)
  if (!res.ok) throw new Error(`加载会话失败：HTTP ${res.status}`)
  const data = await res.json()
  hydrateMessages(data.messages)
  saveConversationId(data.conversation_id)
}

// 初始化会话：优先本地缓存，失败回退到后端最新会话。
const initConversation = async () => {
  // 初始化时优先恢复本地会话，失败后回退到后端最新会话。
  await refreshConversationList()

  // 先尝试本地缓存会话。
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      await loadConversation(Number(saved))
      await nextTick()
      scrollToBottom(true)
      return
    } catch {
      // 缓存失效则清掉。
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  // 回退到后端最新会话。
  const res = await fetch(`${API_BASE}/conversations/latest`)
  if (!res.ok) throw new Error(`初始化会话失败：HTTP ${res.status}`)

  const data = await res.json()
  hydrateMessages(data.messages)
  saveConversationId(data.conversation_id)
  await refreshConversationList()

  await nextTick()
  scrollToBottom(true)
}

// 创建新会话。
const createConversation = async () => {
  // 新建会话并清空当前消息视图。
  const res = await fetch(`${API_BASE}/conversations`, { method: 'POST' })
  if (!res.ok) throw new Error(`新建会话失败：HTTP ${res.status}`)
  const data = await res.json()
  messages.value = []
  canContinue.value = false
  saveConversationId(data.conversation_id)
  await refreshConversationList()
  drawerOpen.value = false
  await nextTick()
  scrollToBottom(true)
}

// 选择并切换会话。
const selectConversation = async (id) => {
  // 切换会话并刷新消息区。
  const nextId = Number(id)
  if (!nextId || nextId === conversationId.value || switchingConversation.value) return

  switchingConversation.value = true
  try {
    await loadConversation(nextId)
    drawerOpen.value = false
    await nextTick()
    scrollToBottom(true)
  } catch (error) {
    messages.value.push({
      role: 'assistant',
      content: `切换会话失败：${error.message}`
    })
  } finally {
    switchingConversation.value = false
  }
}

// 打开删除会话确认弹窗。
const requestDeleteConversation = (id) => {
  // 打开删除确认弹窗并记录目标会话 ID。
  const targetId = Number(id)
  if (!targetId || isBusy.value) return
  pendingDeleteConversationId.value = targetId
  deleteModalOpen.value = true
}

// 取消删除会话。
const cancelDeleteConversation = () => {
  // 关闭删除确认弹窗并清空临时状态。
  deleteModalOpen.value = false
  pendingDeleteConversationId.value = null
}

// 执行删除会话。
const deleteConversation = async () => {
  // 删除目标会话；若删的是当前会话则自动切换到最新会话。
  const targetId = Number(pendingDeleteConversationId.value)
  if (!targetId || isBusy.value) {
    cancelDeleteConversation()
    return
  }

  try {
    const res = await fetch(`${API_BASE}/conversations/${targetId}`, {
      method: 'DELETE'
    })
    if (!res.ok) throw new Error(`删除会话失败：HTTP ${res.status}`)

    if (conversationId.value === targetId) {
      const latestRes = await fetch(`${API_BASE}/conversations/latest`)
      if (!latestRes.ok) throw new Error(`加载会话失败：HTTP ${latestRes.status}`)
      const data = await latestRes.json()
      hydrateMessages(data.messages)
      saveConversationId(data.conversation_id)
      await refreshConversationList()
      await nextTick()
      scrollToBottom(true)
      return
    }

    await refreshConversationList()
  } catch (error) {
    messages.value.push({
      role: 'assistant',
      content: `删除会话失败：${error.message}`
    })
  } finally {
    cancelDeleteConversation()
  }
}

// 主动中止当前流式回复。
const stopGenerating = () => {
  // 主动中止当前流式请求。
  if (!streamAbortController) return
  abortRequested.value = true
  generating.value = false
  fetching.value = false
  stopRequestTimer()
  streamAbortController.abort()
}

const streamChat = async ({ content = '', continueFromLast = false } = {}) => {
  // 核心流式逻辑：发请求、解析 SSE、写入消息与状态。
  let assistantIndex = -1
  let doneTruncated = false
  const messageContent = (content || '').trim()

  loading.value = true
  fetching.value = true
  generating.value = true
  autoScrollEnabled.value = true
  startRequestTimer()

  await nextTick()
  scrollToBottom(true)

  try {
    abortRequested.value = false
    if (continueFromLast) {
      assistantIndex = findLastAssistantIndex()
      if (assistantIndex < 0) {
        assistantIndex =
          messages.value.push({
            role: 'assistant',
            content: ''
          }) - 1
      }
    } else {
      assistantIndex =
        messages.value.push({
          role: 'assistant',
          content: ''
        }) - 1
    }

    streamAbortController = new AbortController()
    const body = {
      conversation_id: conversationId.value,
      continue_from_last: continueFromLast,
      system_prompt: systemPrompt.value,
      system_prompt_preset: systemPromptPreset.value === CUSTOM_PRESET_KEY ? null : systemPromptPreset.value
    }
    if (!continueFromLast) body.content = messageContent

    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: streamAbortController.signal,
      body: JSON.stringify(body)
    })

    if (!res.ok) throw new Error(`请求失败：HTTP ${res.status}`)
    if (!res.body) throw new Error('浏览器不支持流式读取')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let doneConversationId = null

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseEvents(buffer)
      buffer = parsed.rest

      for (const event of parsed.events) {
        if (event.type === 'delta') {
          // 读取本次增量文本，并统一为可拼接的字符串格式。
          const deltaText = normalizeAssistantText(event.content)
          if (continueFromLast) {
            messages.value[assistantIndex].content = appendWithoutOverlap(messages.value[assistantIndex].content, deltaText)
          } else {
            messages.value[assistantIndex].content += deltaText
          }
          if (fetching.value) {
            fetching.value = false
            stopRequestTimer()
          }
          await nextTick()
          scrollToBottom()
          continue
        }
        if (event.type === 'done') {
          doneConversationId = Number(event.conversation_id) || doneConversationId
          doneTruncated = Boolean(event.truncated)
          continue
        }
        if (event.type === 'error') throw new Error(event.message || '流式请求失败')
      }
    }

    buffer += decoder.decode()
    const tail = parseSseEvents(buffer)
    for (const event of tail.events) {
      if (event.type === 'delta') {
        const deltaText = normalizeAssistantText(event.content)
        if (continueFromLast) {
          messages.value[assistantIndex].content = appendWithoutOverlap(messages.value[assistantIndex].content, deltaText)
        } else {
          messages.value[assistantIndex].content += deltaText
        }
      } else if (event.type === 'done') {
        doneConversationId = Number(event.conversation_id) || doneConversationId
        doneTruncated = Boolean(event.truncated)
      } else if (event.type === 'error') {
        throw new Error(event.message || '流式请求失败')
      }
    }

    if (!messages.value[assistantIndex].content.trim()) {
      messages.value[assistantIndex].content = '后端未返回内容。'
    }
    canContinue.value = doneTruncated
    if (doneConversationId) saveConversationId(doneConversationId)
    await refreshConversationList()
  } catch (error) {
    if (error?.name === 'AbortError' && abortRequested.value) {
      if (!continueFromLast && assistantIndex >= 0 && messages.value[assistantIndex] && !messages.value[assistantIndex].content.trim()) {
        messages.value.splice(assistantIndex, 1)
      }
      await refreshConversationList()
    } else {
      canContinue.value = false
      const message = `请求异常：${error.message}`
      if (assistantIndex >= 0 && messages.value[assistantIndex]) {
        if (messages.value[assistantIndex].content.trim()) {
          messages.value[assistantIndex].content += `\n\n${message}`
        } else {
          messages.value[assistantIndex].content = message
        }
      } else {
        messages.value.push({ role: 'assistant', content: message })
      }
      await refreshConversationList()
    }
  } finally {
    abortRequested.value = false
    streamAbortController = null
    generating.value = false
    fetching.value = false
    stopRequestTimer()
    loading.value = false
    await nextTick()
    scrollToBottom()
  }
}

// 发送消息并流式接收回复。
const send = async () => {
  // 发送用户输入并触发新的流式回复。
  const content = input.value.trim()
  if (!content || loading.value || switchingConversation.value) return

  canContinue.value = false
  messages.value.push({ role: 'user', content })
  input.value = ''
  resetTextarea()
  await streamChat({ content, continueFromLast: false })
}

const continueGenerating = async () => {
  // 继续生成上一条被截断的回复。
  if (!canContinue.value || loading.value || switchingConversation.value) return
  canContinue.value = false
  await streamChat({ continueFromLast: true })
}

// Enter 发送；正在生成时 Enter 触发中止。
const handleEnter = (event) => {
  // 回车发送；Shift+Enter 保留换行；生成中回车触发中止。
  if (event.shiftKey) return
  event.preventDefault()
  if (generating.value) {
    stopGenerating()
    return
  }
  send()
}

// 抽屉开关。
const toggleDrawer = () => {
  // 切换移动端侧边栏显示状态。
  drawerOpen.value = !drawerOpen.value
}

// 关闭抽屉。
const closeDrawer = () => {
  // 关闭侧边栏。
  drawerOpen.value = false
}

// 组件挂载：初始化会话。
onMounted(async () => {
  // 组件挂载后执行初始化流程。
  try {
    await initConversation()
  } catch (error) {
    messages.value.push({
      role: 'assistant',
      content: `初始化失败：${error.message}`
    })
  }
})

// 组件卸载：清理计时器与流式连接。
onBeforeUnmount(() => {
  // 组件销毁时清理流式连接与定时器。
  if (streamAbortController) {
    streamAbortController.abort()
    streamAbortController = null
  }
  stopRequestTimer()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <button class="menu-btn" @click="toggleDrawer">☰</button>
      <h1>AI 对话演示</h1>
    </header>

    <div v-if="drawerOpen" class="drawer-backdrop" @click="closeDrawer"></div>

    <aside class="drawer" :class="{ open: drawerOpen }">
      <div class="drawer-head">
        <button class="new-chat-btn" :disabled="isBusy" @click="createConversation">+ 新对话</button>
      </div>

      <div class="conversation-list">
        <div
          v-for="item in conversations"
          :key="item.id"
          class="conversation-item"
          :class="{ active: Number(item.id) === conversationId }"
          :aria-disabled="isBusy"
        >
          <button class="conversation-main" :disabled="isBusy" @click="selectConversation(item.id)">
            <div class="title">{{ conversationTitle(item) }}</div>
            <div class="meta">{{ conversationMeta(item) }}</div>
          </button>
          <button
            class="conversation-delete"
            :disabled="isBusy"
            @click="requestDeleteConversation(item.id)"
            title="删除会话"
          >
            删除
          </button>
        </div>
        <div v-if="conversations.length === 0" class="empty-conversations">暂无对话</div>
      </div>
    </aside>

    <div v-if="deleteModalOpen" class="modal-backdrop" @click="cancelDeleteConversation">
      <div class="confirm-modal" @click.stop>
        <h3>确认删除会话</h3>
        <p>删除后将无法恢复，确定继续吗？</p>
        <div class="modal-actions">
          <button class="modal-btn secondary" :disabled="isBusy" @click="cancelDeleteConversation">取消</button>
          <button class="modal-btn danger" :disabled="isBusy" @click="deleteConversation">删除</button>
        </div>
      </div>
    </div>

    <main class="chat-panel">
      <section ref="messageListRef" class="messages" @scroll="handleMessagesScroll">
        <div v-if="messages.length === 0" class="empty-state">开始一个新对话</div>

        <div v-for="(msg, index) in messages" :key="index" :class="['message-row', msg.role]">
          <div class="bubble" v-html="renderMarkdown(msg.content)"></div>
        </div>

        <div v-if="fetching" class="message-row assistant">
          <div class="bubble loading-bubble">
            <div class="loading-title">
              正在获取回复
              <span class="loading-dots"><i></i><i></i><i></i></span>
            </div>
            <div class="loading-subtitle">已等待 {{ elapsedText }}</div>
            <div class="loading-track"><span></span></div>
          </div>
        </div>
      </section>

      <footer class="composer-wrap">
        <div v-if="canContinue" class="continue-wrap">
          <button
            class="continue-btn"
            :disabled="loading || switchingConversation"
            @click="continueGenerating"
          >
            {{ continueButtonText }}
          </button>
        </div>

        <div class="system-prompt-box">
          <div class="system-prompt-head">
            <div class="system-prompt-tools">
              <span>角色系统 Prompt</span>
              <select
                v-model="systemPromptPreset"
                class="system-prompt-select"
                :disabled="loading || switchingConversation"
                @change="systemPromptPreset !== CUSTOM_PRESET_KEY && applySystemPromptPreset(systemPromptPreset)"
              >
                <option :value="CUSTOM_PRESET_KEY">自定义</option>
                <option v-for="preset in systemPromptPresets" :key="preset.key" :value="preset.key">
                  {{ preset.label }}
                </option>
              </select>
            </div>
            <button
              class="system-prompt-clear"
              :disabled="loading || switchingConversation || !systemPrompt.trim()"
              @click="
                systemPrompt = '';
                systemPromptPreset = CUSTOM_PRESET_KEY
              "
            >
              清空
            </button>
          </div>
          <textarea
            v-model="systemPrompt"
            rows="2"
            placeholder="例如：你是一名严谨、简洁的技术助手，请优先使用中文回答。"
            :disabled="loading || switchingConversation"
          ></textarea>
        </div>

        <div class="composer">
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            placeholder="输入消息..."
            @keydown.enter="handleEnter"
            @input="resizeTextarea"
            :disabled="switchingConversation"
          ></textarea>
          <button
            :disabled="switchingConversation || (!canSend && !generating)"
            class="send-btn"
            :class="{ loading: fetching }"
            @click="generating ? stopGenerating() : send()"
          >
            {{ sendButtonText }}
          </button>
        </div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #ffffff;
  color: #1f2937;
}

:global(#app) {
  width: 100%;
  margin: 0;
  min-height: 100vh;
  text-align: left;
  border: none;
}

.app-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  overflow: hidden;
}

.topbar {
  position: fixed;
  top: 12px;
  left: 16px;
  right: 16px;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.1);
  z-index: 6;
}

.menu-btn {
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #111827;
  border-radius: 8px;
  width: 34px;
  height: 34px;
  cursor: pointer;
}

.topbar h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0;
}

.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.28);
  z-index: 20;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(15, 23, 42, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.confirm-modal {
  width: min(420px, 100%);
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25);
}

.confirm-modal h3 {
  margin: 0;
  font-size: 16px;
  color: #111827;
}

.confirm-modal p {
  margin: 10px 0 0;
  font-size: 13px;
  color: #4b5563;
  line-height: 1.6;
}

.modal-actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.modal-btn {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  background: #ffffff;
  color: #111827;
  font-weight: 600;
}

.modal-btn.secondary:hover {
  background: #f9fafb;
}

.modal-btn.danger {
  border-color: #fca5a5;
  background: #fee2e2;
  color: #991b1b;
}

.modal-btn.danger:hover {
  background: #fecaca;
}

.modal-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.drawer {
  position: fixed;
  top: 0;
  left: 0;
  height: 100vh;
  width: 280px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  transform: translateX(-100%);
  transition: transform 0.2s ease;
  z-index: 21;
  display: flex;
  flex-direction: column;
}

.drawer.open {
  transform: translateX(0);
}

.drawer-head {
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
}

.new-chat-btn {
  width: 100%;
  border: 1px solid #d1d5db;
  background: #f9fafb;
  color: #111827;
  padding: 10px 12px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
}

.new-chat-btn:hover {
  background: #f3f4f6;
}

.new-chat-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
}

.conversation-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  padding: 6px;
}

.conversation-item:hover {
  background: #f3f4f6;
}

.conversation-item.active {
  background: #eef2ff;
}

.conversation-item:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.conversation-main {
  border: none;
  background: transparent;
  color: #111827;
  text-align: left;
  cursor: pointer;
  flex: 1;
  padding: 4px;
}

.conversation-main:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.conversation-delete {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #ffffff;
  color: #b91c1c;
  font-size: 11px;
  padding: 4px 6px;
  cursor: pointer;
}

.conversation-delete:hover {
  background: #fef2f2;
}

.conversation-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.conversation-main .title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-main .meta {
  margin-top: 4px;
  font-size: 11px;
  color: #6b7280;
}

.empty-conversations {
  color: #6b7280;
  font-size: 12px;
  padding: 8px;
}

.chat-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 82px 0 18px;
  background: #ffffff;
}

.empty-state {
  color: #6b7280;
  text-align: center;
  margin-top: 80px;
}

.message-row {
  display: flex;
  gap: 12px;
  padding: 18px 16px;
}

.message-row.user {
  background: #ffffff;
  justify-content: flex-end;
}

.message-row.assistant {
  background: transparent;
}

.bubble {
  width: 100%;
  line-height: 1.7;
  white-space: normal;
  word-break: break-word;
  padding: 0;
  border-radius: 0;
}

.message-row.user .bubble {
  width: fit-content;
  max-width: min(78%, 920px);
  border-radius: 12px;
  padding: 10px 12px;
  background: #111827;
  color: #ffffff;
  text-align: right;
}

.message-row.assistant .bubble {
  background: transparent;
  color: #111827;
  border: none;
  text-align: left;
}

.bubble :deep(p) {
  margin: 0 0 10px;
}

.bubble :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  background: #f7f7f8;
  color: #111827;
  overflow-x: auto;
}

.bubble :deep(code) {
  font-family: Consolas, 'Courier New', monospace;
}

.bubble :deep(pre code) {
  background: transparent;
  padding: 0;
  border-radius: 0;
}

.bubble :deep(:not(pre) > code) {
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 1px 6px;
}

.loading-bubble {
  color: #1f2937;
}

.loading-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.loading-subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
}

.loading-dots {
  display: inline-flex;
  gap: 5px;
}

.loading-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6b7280;
  animation: dot-jump 1s infinite ease-in-out;
}

.loading-dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.loading-dots i:nth-child(3) {
  animation-delay: 0.3s;
}

.loading-track {
  margin-top: 10px;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: #e5e7eb;
}

.loading-track span {
  display: block;
  width: 36%;
  height: 100%;
  background: linear-gradient(90deg, #d1d5db 0%, #9ca3af 100%);
  animation: loading-slide 1.2s infinite ease-in-out;
}

.composer-wrap {
  position: relative;
  border-top: none;
  padding: 8px 16px 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, #ffffff 28%);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.continue-wrap {
  display: flex;
  justify-content: flex-end;
}

.continue-btn {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 7px 12px;
  background: #ffffff;
  color: #111827;
  font-weight: 600;
  cursor: pointer;
}

.continue-btn:hover {
  background: #f9fafb;
}

.continue-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.system-prompt-box {
  border: 1px solid #d1d5db;
  border-radius: 12px;
  background: #ffffff;
  padding: 10px;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
}

.system-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #374151;
  font-weight: 600;
}

.system-prompt-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.system-prompt-select {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  color: #111827;
  font-size: 12px;
  padding: 4px 6px;
  outline: none;
}

.system-prompt-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.system-prompt-clear {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  color: #111827;
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
}

.system-prompt-clear:hover {
  background: #f9fafb;
}

.system-prompt-clear:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.system-prompt-box textarea {
  width: 100%;
  min-height: 52px;
  max-height: 140px;
  resize: vertical;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px 10px;
  outline: none;
  font: inherit;
  line-height: 1.5;
  color: #111827;
  background: #ffffff;
}

.system-prompt-box textarea::placeholder {
  color: #9ca3af;
}

.system-prompt-box textarea:disabled {
  background: #f9fafb;
  color: #6b7280;
}

.composer {
  max-width: 100%;
  display: flex;
  gap: 10px;
  align-items: center;
  border: 1px solid #d1d5db;
  border-radius: 14px;
  background: #ffffff;
  padding: 10px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}

.composer textarea {
  flex: 1;
  height: 24px;
  min-height: 24px;
  max-height: 160px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: #111827;
  font: inherit;
  line-height: 24px;
  padding: 0;
  margin: 0;
}

.composer textarea::placeholder {
  color: #6b7280;
}

.send-btn {
  border: none;
  border-radius: 8px;
  padding: 10px 12px;
  background: #111827;
  color: #ffffff;
  cursor: pointer;
  font-weight: 700;
}

.send-btn.loading {
  background: #7f1d1d;
}

.send-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes dot-jump {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  40% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@keyframes loading-slide {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(380%);
  }
}
</style>
