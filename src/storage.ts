import type { KnowledgeTree, Settings } from './types'
import type { Depth, Tone } from './types'
import { uid } from './types'

const TREES_KEY = 'kt_trees_v1'
const ACTIVE_KEY = 'kt_active_v1'
const SETTINGS_KEY = 'kt_settings_v2'

export function loadTrees(): KnowledgeTree[] {
  try {
    const trees = JSON.parse(localStorage.getItem(TREES_KEY) ?? '[]') as KnowledgeTree[]
    // 一次性迁移：UI 版本变更（卡片尺寸体系变化）后，清掉按旧卡片几何保存的手动位置，
    // 避免旧位置 + 新尺寸形成大范围初始堆叠
    const migrated = trees.map((t) => {
      if (!localStorage.getItem('kt_layout_v2')) {
        return { ...t, manualPos: {} }
      }
      return t
    })
    if (!localStorage.getItem('kt_layout_v2')) localStorage.setItem('kt_layout_v2', '1')
    // 数据修复：根节点已展开过，误触根的「展开说说」产生的泛化主干一律移除
    return migrated.map((t) => ({
      ...t,
      root: {
        ...t.root,
        children: t.root.children.filter((c) => c.expandedFrom !== 'A标准下探'),
      },
    }))
  } catch {
    return []
  }
}

export function saveTrees(trees: KnowledgeTree[]) {
  localStorage.setItem(TREES_KEY, JSON.stringify(trees))
}

export function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY)
}

export function saveActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id)
  else localStorage.removeItem(ACTIVE_KEY)
}

export const defaultSettings: Settings = {
  // 优先级：localStorage 已保存的非空值 > .env.local 注入 > 内置默认
  apiKey: import.meta.env.VITE_GLM_API_KEY ?? '',
  baseUrl: import.meta.env.VITE_GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
  model: import.meta.env.VITE_GLM_MODEL ?? 'glm-4.6',
  depth: 'beginner' as Depth,
  tone: 'teacher' as Tone,
  background: '',
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>
    const merged = { ...defaultSettings }
    for (const k of Object.keys(defaultSettings) as (keyof Settings)[]) {
      const v = saved[k]
      if (typeof v === 'string' && v) {
        ;(merged as unknown as Record<string, string>)[k] = v
      }
    }
    return merged
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

export function exportTree(tree: KnowledgeTree) {
  const blob = new Blob([JSON.stringify(tree, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${tree.domain}-知识树-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function importTree(file: File): Promise<KnowledgeTree> {
  const text = await file.text()
  const data = JSON.parse(text)
  if (!data.root || !data.root.title) throw new Error('文件格式不正确：缺少 root 节点')
  // 防止 id 冲突，整体换新 id
  return { ...data, id: uid() } as KnowledgeTree
}
