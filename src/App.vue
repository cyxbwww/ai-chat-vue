<script setup>
import { computed, ref } from 'vue'
import ChatView from './views/ChatView.vue'
import DocumentListView from './views/DocumentListView.vue'

// 根组件页面路由状态（轻量切换，不引入 vue-router）。
const activePage = ref('chat')
const isChat = computed(() => activePage.value === 'chat')
</script>

<template>
  <div class="root-shell">
    <header class="root-nav">
      <!-- 根组件仅负责页面切换与视图挂载。 -->
      <button class="nav-btn" :class="{ active: isChat }" @click="activePage = 'chat'">对话页</button>
      <button class="nav-btn" :class="{ active: !isChat }" @click="activePage = 'documents'">文档列表</button>
    </header>

    <main class="root-main">
      <ChatView v-if="isChat" />
      <DocumentListView v-else />
    </main>
  </div>
</template>

<style scoped>
.root-shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f8fafc;
}

.root-nav {
  flex: 0 0 52px;
  min-height: 52px;
  z-index: 50;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
}

.nav-btn {
  cursor: pointer;
  padding: 7px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #ffffff;
  color: #111827;
  font-weight: 600;
}

.nav-btn.active {
  border-color: #111827;
  background: #111827;
  color: #ffffff;
}

.root-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
