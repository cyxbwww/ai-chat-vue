const API_BASE = 'http://127.0.0.1:8000'

// 上传文档到后端。
export async function uploadDocument(file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${API_BASE}/rag/documents`, {
    method: 'POST',
    body: formData
  })
  if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`)
  return res.json()
}

// 获取文档列表。
export async function fetchDocuments(limit = 100, offset = 0) {
  const res = await fetch(`${API_BASE}/rag/documents?limit=${limit}&offset=${offset}`)
  if (!res.ok) throw new Error(`加载文档列表失败：HTTP ${res.status}`)
  return res.json()
}

// 为指定文档构建索引。
export async function buildDocumentIndex(documentId) {
  const res = await fetch(`${API_BASE}/rag/documents/${documentId}/index`, {
    method: 'POST'
  })
  if (!res.ok) throw new Error(`建索引失败：HTTP ${res.status}`)
  return res.json()
}

