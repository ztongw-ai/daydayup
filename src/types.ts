export type NodeKind = 'root' | 'standard' | 'question'
export type NodeStatus = 'unknown' | 'mastered' | 'blind'
export type ExpandMode = 'A标准下探' | 'B疑问下探'
/** AI 讲解深度 */
export type Depth = 'beginner' | 'intermediate' | 'expert'
/** AI 讲解口吻 */
export type Tone = 'teacher' | 'doc' | 'practitioner'
/** 学习优先级：P0 先学 / P1 重要 / P2 按需 */
export type Priority = 'P0' | 'P1' | 'P2'

/** 学习档案：从用户原始需求提炼，驱动整棵知识树的生成 */
export interface LearningProfile {
  domain: string      // 凝练的领域名（树的名字/根节点标题）
  learner: string     // 学习者画像：已有背景/技能/认知与空白
  goal: string        // 学习目标：学完要能做成什么
  perspective: string // 学习视角（如商务解决方案视角，非生产实操）
  avoid: string       // 明确不必深入的（无则"无"）
  raw: string         // 用户原始输入
}

export interface KNode {
  id: string
  parentId: string | null
  title: string
  content: string
  kind: NodeKind
  status: NodeStatus
  collapsed: boolean
  expanded: boolean // 是否已执行过模式A下探
  expandedFrom?: ExpandMode
  question?: string // 模式B的原始疑问
  priority?: Priority // 学习优先级（主干节点）
  children: KNode[]
  createdAt: number
}

export interface KnowledgeTree {
  id: string
  domain: string
  createdAt: number
  updatedAt: number
  root: KNode
  /** 学习档案（新树两步生成产生；旧树可能没有） */
  profile?: LearningProfile
  /** 用户手动拖拽过的节点位置（id → 画布坐标），「整理布局」时清空 */
  manualPos?: Record<string, { x: number; y: number }>
}

export interface Settings {
  apiKey: string
  baseUrl: string
  model: string
  depth: Depth
  tone: Tone
  /** 学习者背景（熟悉领域/技能），AI 打比方时优先取材于此 */
  background: string
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export const newNode = (partial: Partial<KNode> & { title: string }): KNode => ({
  id: uid(),
  parentId: null,
  content: '',
  kind: 'standard',
  status: 'unknown',
  collapsed: false,
  expanded: false,
  children: [],
  createdAt: Date.now(),
  ...partial,
})

/** 深度优先查找节点 */
export function findNode(node: KNode, id: string): KNode | null {
  if (node.id === id) return node
  for (const c of node.children) {
    const r = findNode(c, id)
    if (r) return r
  }
  return null
}

/** 同层级兄弟导航：返回同父节点下的上一个/下一个节点（详情抽屉 ‹ › 用） */
export function siblingsAround(root: KNode, id: string): {
  prev: KNode | null; next: KNode | null; index: number; total: number
} {
  let result = { prev: null as KNode | null, next: null as KNode | null, index: -1, total: 0 }
  const walk = (n: KNode): boolean => {
    const idx = n.children.findIndex((c) => c.id === id)
    if (idx >= 0) {
      result = {
        prev: idx > 0 ? n.children[idx - 1] : null,
        next: idx < n.children.length - 1 ? n.children[idx + 1] : null,
        index: idx,
        total: n.children.length,
      }
      return true
    }
    return n.children.some(walk)
  }
  walk(root)
  return result
}

/** 获取从根到节点的路径（含 id，用于详情面板可点击面包屑） */
export function pathNodes(root: KNode, id: string): { id: string; title: string }[] {
  const walk = (n: KNode, trail: { id: string; title: string }[]): { id: string; title: string }[] | null => {
    if (n.id === id) return [...trail, { id: n.id, title: n.title }]
    for (const c of n.children) {
      const r = walk(c, [...trail, { id: n.id, title: n.title }])
      if (r) return r
    }
    return null
  }
  return walk(root, []) ?? []
}

/** 获取从根到节点的标题路径 */
export function pathOf(root: KNode, id: string): string[] {
  const walk = (n: KNode, trail: string[]): string[] | null => {
    if (n.id === id) return [...trail, n.title]
    for (const c of n.children) {
      const r = walk(c, [...trail, n.title])
      if (r) return r
    }
    return null
  }
  return walk(root, []) ?? []
}

/** 递归统计节点数 */
export function countNodes(node: KNode): number {
  return 1 + node.children.reduce((s, c) => s + countNodes(c), 0)
}

/** 克隆整棵树（用于不可变更新） */
export const cloneTree = (root: KNode): KNode =>
  JSON.parse(JSON.stringify(root))

/** 对树中目标节点执行更新，返回新根 */
export function updateNode(
  root: KNode,
  id: string,
  fn: (n: KNode) => void,
): KNode {
  const next = cloneTree(root)
  const target = findNode(next, id)
  if (target) fn(target)
  return next
}
