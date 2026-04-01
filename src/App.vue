<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { marked } from 'marked'

// 输入框与 DOM 引用。
const input = ref('')
const inputRef = ref(null)
const messageListRef = ref(null)

// 聊天消息状态。
const messages = ref([])
const loading = ref(false)
const fetching = ref(false)
const requestElapsed = ref(0)

// 会话状态。
const conversationId = ref(null)
const conversations = ref([])
const switchingConversation = ref(false)
const drawerOpen = ref(false)

// 接口地址与本地缓存键。
const API_BASE = 'http://127.0.0.1:8000'
const STORAGE_KEY = 'ai-chat-conversation-id'

// 请求耗时计时器句柄。
let requestTimer = null
let streamAbortController = null

// Markdown 渲染配置。
marked.setOptions({ gfm: true, breaks: true })

// 派生 UI 状态。
const canSend = computed(() => input.value.trim().length > 0 && !loading.value)
const sendButtonText = computed(() => (fetching.value ? '获取中...' : '发送'))
const elapsedText = computed(() => `${requestElapsed.value.toFixed(1)} 秒`)
const isBusy = computed(() => loading.value || switchingConversation.value)

// 将消息列表滚动到底部。
const scrollToBottom = () => {
  const el = messageListRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight + 1000
}

// 输入时自动调整文本框高度。
const resizeTextarea = () => {
  const el = inputRef.value
  if (!el) return
  // 先重置高度，再根据内容撑开。
  el.style.height = '24px'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}

// 发送后恢复单行高度。
const resetTextarea = () => {
  const el = inputRef.value
  if (!el) return
  el.style.height = '24px'
}

// 开始请求耗时计时。
const startRequestTimer = () => {
  requestElapsed.value = 0
  if (requestTimer) clearInterval(requestTimer)
  const startAt = Date.now()
  // 每 100ms 刷新一次耗时展示。
  requestTimer = setInterval(() => {
    requestElapsed.value = (Date.now() - startAt) / 1000
  }, 100)
}

// 停止请求耗时计时。
const stopRequestTimer = () => {
  if (!requestTimer) return
  clearInterval(requestTimer)
  requestTimer = null
}

// 将模型返回统一转换为可展示文本。
const normalizeAssistantText = (value) => {
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

// Markdown 文本转 HTML。
const renderMarkdown = (value) => marked.parse(normalizeAssistantText(value))

// 生成会话列表中的简短预览文本。
const previewText = (value, fallback) => {
  const text = normalizeAssistantText(value).replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 32 ? `${text.slice(0, 32)}...` : text
}

// 会话标题：优先 title，其次最近消息摘要。
const conversationTitle = (item) => {
  if (item.title && String(item.title).trim()) {
    return previewText(item.title, `会话 #${item.id}`)
  }
  return previewText(item.last_message, `会话 #${item.id}`)
}

// 会话时间信息格式化。
const conversationMeta = (item) => {
  if (item.last_message_at) {
    return String(item.last_message_at).replace('T', ' ').slice(0, 16)
  }
  if (item.created_at) {
    return String(item.created_at).replace('T', ' ').slice(0, 16)
  }
  return '暂无消息'
}

// 从 SSE 文本缓冲中提取完整事件。
const parseSseEvents = (buffer) => {
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
  if (!id) return
  conversationId.value = id
  localStorage.setItem(STORAGE_KEY, String(id))
}

// 拉取侧边栏会话列表。
const refreshConversationList = async () => {
  const res = await fetch(`${API_BASE}/conversations`)
  if (!res.ok) {
    throw new Error(`加载会话列表失败：HTTP ${res.status}`)
  }
  const data = await res.json()
  conversations.value = data.conversations || []
}

// 用后端返回的数据重建消息列表。
const hydrateMessages = (items) => {
  messages.value = (items || []).map((item) => ({
    role: item.role,
    content: item.content
  }))
}

// 加载指定会话并切换上下文。
const loadConversation = async (id) => {
  const res = await fetch(`${API_BASE}/conversations/${id}/messages`)
  if (!res.ok) {
    throw new Error(`加载会话失败：HTTP ${res.status}`)
  }
  const data = await res.json()
  hydrateMessages(data.messages)
  saveConversationId(data.conversation_id)
}

// 启动初始化：优先恢复本地会话，失败则加载后端最新会话。
const initConversation = async () => {
  await refreshConversationList()

  // 先尝试本地缓存会话。
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      await loadConversation(Number(saved))
      await nextTick()
      scrollToBottom()
      return
    } catch {
      // 缓存失效则清掉。
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  // 回退到后端最新会话。
  const res = await fetch(`${API_BASE}/conversations/latest`)
  if (!res.ok) {
    throw new Error(`初始化会话失败：HTTP ${res.status}`)
  }

  const data = await res.json()
  hydrateMessages(data.messages)
  saveConversationId(data.conversation_id)
  await refreshConversationList()

  await nextTick()
  scrollToBottom()
}

// 创建新会话并切换到该会话。
const createConversation = async () => {
  const res = await fetch(`${API_BASE}/conversations`, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`新建会话失败：HTTP ${res.status}`)
  }
  const data = await res.json()
  messages.value = []
  saveConversationId(data.conversation_id)
  await refreshConversationList()
  drawerOpen.value = false

  await nextTick()
  scrollToBottom()
}

// 从侧边栏切换会话。
const selectConversation = async (id) => {
  const nextId = Number(id)
  if (!nextId || nextId === conversationId.value || switchingConversation.value) return

  switchingConversation.value = true
  try {
    await loadConversation(nextId)
    drawerOpen.value = false
    await nextTick()
    scrollToBottom()
  } catch (error) {
    messages.value.push({
      role: 'assistant',
      content: `切换会话失败：${error.message}`
    })
  } finally {
    switchingConversation.value = false
  }
}

// 发送消息并流式接收助手回复。
const send = async () => {
  const content = input.value.trim()
  if (!content || loading.value || switchingConversation.value) return

  // 先本地插入用户消息，提升交互响应。
  messages.value.push({
    role: 'user',
    content
  })

  // 清空输入并进入请求状态。
  input.value = ''
  resetTextarea()
  loading.value = true
  fetching.value = true
  startRequestTimer()

  await nextTick()
  scrollToBottom()

  let assistantIndex = -1
  try {
    assistantIndex =
      messages.value.push({
        role: 'assistant',
        content: ''
      }) - 1

    streamAbortController = new AbortController()
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: streamAbortController.signal,
      body: JSON.stringify({
        conversation_id: conversationId.value,
        content
      })
    })

    if (!res.ok) {
      throw new Error(`请求失败：HTTP ${res.status}`)
    }
    if (!res.body) {
      throw new Error('浏览器不支持流式读取')
    }

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
          messages.value[assistantIndex].content += normalizeAssistantText(event.content)
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
          continue
        }
        if (event.type === 'error') {
          throw new Error(event.message || '流式请求失败')
        }
      }
    }

    // 处理流结束后残余片段。
    buffer += decoder.decode()
    const tail = parseSseEvents(buffer)
    for (const event of tail.events) {
      if (event.type === 'delta') {
        messages.value[assistantIndex].content += normalizeAssistantText(event.content)
      } else if (event.type === 'done') {
        doneConversationId = Number(event.conversation_id) || doneConversationId
      } else if (event.type === 'error') {
        throw new Error(event.message || '流式请求失败')
      }
    }

    if (!messages.value[assistantIndex].content.trim()) {
      messages.value[assistantIndex].content = '后端未返回内容。'
    }
    if (doneConversationId) {
      saveConversationId(doneConversationId)
    }
    await refreshConversationList()
  } catch (error) {
    const message = error?.name === 'AbortError' ? '请求已取消。' : `请求异常：${error.message}`
    if (assistantIndex >= 0 && messages.value[assistantIndex]) {
      if (messages.value[assistantIndex].content.trim()) {
        messages.value[assistantIndex].content += `\n\n${message}`
      } else {
        messages.value[assistantIndex].content = message
      }
    } else {
      messages.value.push({
        role: 'assistant',
        content: message
      })
    }
  } finally {
    // 无论成功失败都收敛状态并滚到底部。
    streamAbortController = null
    fetching.value = false
    stopRequestTimer()
    loading.value = false
    await nextTick()
    scrollToBottom()
  }
}

// Enter 发送；Shift+Enter 换行。
const handleEnter = (event) => {
  if (event.shiftKey) return
  event.preventDefault()
  send()
}

// 顶部按钮切换抽屉显隐。
const toggleDrawer = () => {
  drawerOpen.value = !drawerOpen.value
}

// 点击遮罩关闭抽屉。
const closeDrawer = () => {
  drawerOpen.value = false
}

// 组件挂载时初始化会话。
onMounted(async () => {
  try {
    await initConversation()
  } catch (error) {
    // 初始化失败时在消息区显示错误。
    messages.value.push({
      role: 'assistant',
      content: `初始化失败：${error.message}`
    })
  }
})

// 组件卸载时清理计时器与流连接。
onBeforeUnmount(() => {
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
        <button
          v-for="item in conversations"
          :key="item.id"
          class="conversation-item"
          :class="{ active: Number(item.id) === conversationId }"
          :disabled="isBusy"
          @click="selectConversation(item.id)"
        >
          <div class="title">{{ conversationTitle(item) }}</div>
          <div class="meta">{{ conversationMeta(item) }}</div>
        </button>

        <div v-if="conversations.length === 0" class="empty-conversations">暂无对话</div>
      </div>
    </aside>

    <main class="chat-panel">
      <section ref="messageListRef" class="messages">
        <div v-if="messages.length === 0" class="empty-state">开始一个新对话</div>

        <div
          v-for="(msg, index) in messages"
          :key="index"
          :class="['message-row', msg.role]"
        >
          <div class="bubble" v-html="renderMarkdown(msg.content)"></div>
        </div>

        <div v-if="fetching" class="message-row assistant">
          <div class="bubble loading-bubble">
            <div class="loading-title">
              正在获取回复
              <span class="loading-dots">
                <i></i><i></i><i></i>
              </span>
            </div>
            <div class="loading-subtitle">已等待 {{ elapsedText }}</div>
            <div class="loading-track"><span></span></div>
          </div>
        </div>
      </section>

      <footer class="composer-wrap">
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
          <button :disabled="!canSend || switchingConversation" class="send-btn" :class="{ loading: fetching }" @click="send">
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
  border: none;
  background: transparent;
  color: #111827;
  text-align: left;
  border-radius: 8px;
  padding: 10px;
  cursor: pointer;
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

.conversation-item .title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-item .meta {
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
  padding: 82px 0 128px;
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
  position: fixed;
  left: 0;
  right: 0;
  bottom: 14px;
  z-index: 5;
  border-top: none;
  padding: 0 16px;
  background: transparent;
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
  background: #1f2937;
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
