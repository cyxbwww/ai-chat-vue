<script setup>
import { onMounted, ref } from 'vue'
import { buildDocumentIndex, fetchDocuments, uploadDocument } from '../api/rag'

// 文档列表状态。
const documents = ref([])
const loading = ref(false)
const uploading = ref(false)
const errorMessage = ref('')

const loadDocuments = async () => {
  // 拉取文档列表并刷新页面数据。
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await fetchDocuments()
    documents.value = data.documents || []
  } catch (error) {
    errorMessage.value = error.message || '加载失败'
  } finally {
    loading.value = false
  }
}

const handleFileChange = async (event) => {
  // 选择文件后立即上传并刷新列表。
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return

  uploading.value = true
  errorMessage.value = ''
  try {
    await uploadDocument(file)
    await loadDocuments()
  } catch (error) {
    errorMessage.value = error.message || '上传失败'
  } finally {
    uploading.value = false
  }
}

const indexDocument = async (item) => {
  // 单条文档构建立索引。
  errorMessage.value = ''
  try {
    await buildDocumentIndex(item.id)
    await loadDocuments()
  } catch (error) {
    errorMessage.value = error.message || '建立索引失败'
  }
}

onMounted(loadDocuments)
</script>

<template>
  <section class="doc-page">
    <header class="doc-head">
      <h2>知识库文档</h2>
      <label class="upload-btn" :class="{ disabled: uploading }">
        {{ uploading ? '上传中...' : '上传文档' }}
        <input type="file" :disabled="uploading" @change="handleFileChange" />
      </label>
    </header>

    <p v-if="errorMessage" class="error-msg">{{ errorMessage }}</p>
    <p v-else-if="loading" class="loading-msg">正在加载文档...</p>

    <div v-else class="doc-list">
      <div v-if="documents.length === 0" class="empty-doc">暂无文档，请先上传。</div>
      <article v-for="item in documents" :key="item.id" class="doc-item">
        <div class="doc-main">
          <div class="doc-title">{{ item.file_name || `文档 #${item.id}` }}</div>
          <div class="doc-meta">
            <span>ID: {{ item.id }}</span>
            <span>状态: {{ item.status }}</span>
            <span>大小: {{ item.file_size || 0 }} B</span>
            <span>切块: {{ item.chunk_count ?? 0 }}</span>
          </div>
        </div>
        <button class="index-btn" @click="indexDocument(item)">建立索引</button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.doc-page {
  max-width: 1080px;
  height: 100%;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.doc-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.doc-head h2 {
  margin: 0;
  color: #111827;
  font-size: 20px;
}

.upload-btn {
  position: relative;
  cursor: pointer;
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #ffffff;
  color: #111827;
  font-weight: 600;
}

.upload-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.upload-btn.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.upload-btn.disabled input {
  cursor: not-allowed;
}

.error-msg {
  color: #b91c1c;
  margin-top: 12px;
}

.loading-msg,
.empty-doc {
  color: #6b7280;
  margin-top: 12px;
}

.doc-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.doc-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #ffffff;
}

.doc-title {
  color: #111827;
  font-weight: 600;
  word-break: break-all;
}

.doc-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: #6b7280;
  font-size: 12px;
}

.index-btn {
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #ffffff;
  color: #111827;
  padding: 8px 10px;
  font-weight: 600;
  height: fit-content;
}
</style>
