<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { marked } from 'marked'

const input = ref('')
const messageListRef = ref(null)
const messages = ref([])
const loading = ref(false)
const fetching = ref(false)
const typingMessageIndex = ref(-1)
const requestElapsed = ref(0)
const API_URL = 'http://127.0.0.1:8000/chat'

let requestTimer = null

marked.setOptions({ gfm: true, breaks: true })

const canSend = computed(() => input.value.trim().length > 0 && !loading.value)
const sendButtonText = computed(() => (fetching.value ? '获取中...' : '发送'))
const elapsedText = computed(() => `${requestElapsed.value.toFixed(1)} 秒`)

const scrollToBottom = () => {
  const el = messageListRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const startRequestTimer = () => {
  requestElapsed.value = 0
  if (requestTimer) clearInterval(requestTimer)
  const startAt = Date.now()
  requestTimer = setInterval(() => {
    requestElapsed.value = (Date.now() - startAt) / 1000
  }, 100)
}

const stopRequestTimer = () => {
  if (!requestTimer) return
  clearInterval(requestTimer)
  requestTimer = null
}

const getTypingDelay = (char, totalChars) => {
  const baseDelay = totalChars > 240 ? 14 : 30
  const punctuation = '，。！？；：,.!?;:'
  return punctuation.includes(char) ? baseDelay + 70 : baseDelay
}

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

const renderMarkdown = (value) => marked.parse(normalizeAssistantText(value))

const typeAssistantMessage = async (text) => {
  const content = normalizeAssistantText(text) || '后端未返回内容。'
  const index =
    messages.value.push({
      role: 'assistant',
      content: ''
    }) - 1
  typingMessageIndex.value = index

  await nextTick()
  scrollToBottom()

  const chars = Array.from(content)
  try {
    for (let i = 0; i < chars.length; i += 1) {
      messages.value[index].content += chars[i]
      if (i % 4 === 0) {
        await nextTick()
        scrollToBottom()
      }
      await sleep(getTypingDelay(chars[i], chars.length))
    }
  } finally {
    typingMessageIndex.value = -1
    await nextTick()
    scrollToBottom()
  }
}

const send = async () => {
  const content = input.value.trim()
  if (!content || loading.value) return

  messages.value.push({
    role: 'user',
    content
  })

  input.value = ''
  loading.value = true
  fetching.value = true
  startRequestTimer()

  await nextTick()
  scrollToBottom()

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: messages.value
      })
    })

    if (!res.ok) {
      throw new Error(`请求失败：HTTP ${res.status}`)
    }

    const data = await res.json()
    fetching.value = false
    stopRequestTimer()
    await typeAssistantMessage(data.answer)
  } catch (error) {
    fetching.value = false
    stopRequestTimer()
    await typeAssistantMessage(`请求异常：${error.message}`)
  } finally {
    fetching.value = false
    stopRequestTimer()
    loading.value = false
    await nextTick()
    scrollToBottom()
  }
}

const handleEnter = (event) => {
  if (event.shiftKey) return
  event.preventDefault()
  send()
}

onBeforeUnmount(() => {
  stopRequestTimer()
})
</script>

<template>
  <div class="app-shell">
    <main class="chat-panel">
      <header class="topbar">
        <h1>AI 对话演示</h1>
        <p>后端地址：{{ API_URL }}</p>
      </header>

      <section ref="messageListRef" class="messages">
        <div v-if="messages.length === 0" class="empty-state">
          在下方输入消息，按 Enter 发送。
        </div>

        <div
          v-for="(msg, index) in messages"
          :key="index"
          :class="['message-row', msg.role, { 'is-typing': index === typingMessageIndex }]"
        >
          <div class="avatar">{{ msg.role === 'user' ? 'U' : 'AI' }}</div>
          <div class="bubble" v-html="renderMarkdown(msg.content)"></div>
        </div>

        <div v-if="fetching" class="message-row assistant">
          <div class="avatar">AI</div>
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
            v-model="input"
            rows="1"
            placeholder="输入消息...（Enter 发送，Shift+Enter 换行）"
            @keydown.enter="handleEnter"
          ></textarea>
          <button :disabled="!canSend" class="send-btn" :class="{ loading: fetching }" @click="send">
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
  background: #f2f4f8;
  color: #1f2937;
}

:global(#app) {
  min-height: 100vh;
}

.app-shell {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: stretch;
}

.chat-panel {
  width: min(980px, 100vw);
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #ffffff;
}

.topbar {
  padding: 20px 24px 14px;
  border-bottom: 1px solid #e5e7eb;
}

.topbar h1 {
  margin: 0;
  font-size: 22px;
}

.topbar p {
  margin: 6px 0 0;
  color: #6b7280;
  font-size: 13px;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
}

.empty-state {
  color: #6b7280;
  text-align: center;
  margin-top: 56px;
}

.message-row {
  display: flex;
  width: 100%;
  margin-bottom: 14px;
  gap: 10px;
}

.message-row.user {
  justify-content: flex-start;
  flex-direction: row-reverse;
}

.message-row.assistant {
  justify-content: flex-start;
  text-align: left;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: #111827;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}

.message-row.assistant .avatar {
  background: #e5e7eb;
  color: #111827;
}

.bubble {
  max-width: min(80%, 760px);
  border-radius: 16px;
  padding: 12px 14px;
  line-height: 1.6;
  text-align: left;
  white-space: normal;
  word-break: break-word;
}

.bubble :deep(p) {
  margin: 0 0 8px;
}

.bubble :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 39, 0.92);
  color: #f9fafb;
  overflow-x: auto;
}

.bubble :deep(code) {
  font-family: Consolas, "Courier New", monospace;
}

.message-row.user .bubble {
  background: #111827;
  color: #ffffff;
}

.message-row.assistant .bubble {
  background: #ffffff;
  color: #111827;
  border: 1px solid #e5e7eb;
}

.message-row.assistant.is-typing .bubble::after {
  content: "|";
  margin-left: 2px;
  color: #6b7280;
  animation: caret-blink 1s steps(1) infinite;
}

.loading-bubble {
  min-width: min(64vw, 340px);
}

.loading-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
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

.loading-subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
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
  padding: 14px 24px 22px;
  border-top: 1px solid #e5e7eb;
  background: #ffffff;
}

.composer {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  background: #f9fafb;
  border: 1px solid #d1d5db;
  border-radius: 16px;
  padding: 10px;
}

.composer textarea {
  flex: 1;
  min-height: 28px;
  max-height: 160px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  line-height: 1.6;
}

.send-btn {
  border: none;
  border-radius: 12px;
  padding: 10px 16px;
  background: #111827;
  color: #ffffff;
  font-weight: 700;
  cursor: pointer;
}

.send-btn.loading {
  background: #1f2937;
}

.send-btn:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .topbar,
  .messages,
  .composer-wrap {
    padding-left: 14px;
    padding-right: 14px;
  }

  .composer {
    flex-direction: column;
    align-items: stretch;
  }
}

@keyframes caret-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
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
