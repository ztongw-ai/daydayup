import dagre from '@dagrejs/dagre'
import type { KNode } from './types'

export const NODE_W = 300
export const NODE_H = 120 // 未测量前的初始估计值，真实高度以卡片实测为准

/** 卡片自身需求宽度（三档 + 根/追问特例） */
export function widthFor(node: KNode): number {
  if (node.kind === 'root') return 340
  if (node.kind === 'question') return 420
  const len = node.content.length
  if (len > 180) return 420
  if (len > 60) return 300
  return 260
}

/** 每一层级（列）统一宽度 = 该层可见卡片的最大需求宽度，保证同列等宽对齐 */
export function levelWidths(root: KNode): Map<string, number> {
  const levelMax = new Map<number, number>()
  const scan = (n: KNode, d: number) => {
    levelMax.set(d, Math.max(levelMax.get(d) ?? 0, widthFor(n)))
    if (!n.collapsed) n.children.forEach((c) => scan(c, d + 1))
  }
  scan(root, 0)
  const out = new Map<string, number>()
  const assign = (n: KNode, d: number) => {
    out.set(n.id, levelMax.get(d) ?? NODE_W)
    if (!n.collapsed) n.children.forEach((c) => assign(c, d + 1))
  }
  assign(root, 0)
  return out
}

export interface NodeSize {
  w: number
  h: number
}

export interface PlacedNode {
  node: KNode
  x: number
  y: number
}

/** 每个可见节点的层级深度（用于列底色区分与小地图配色） */
export function levelDepths(root: KNode): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (n: KNode, d: number) => {
    out.set(n.id, d)
    if (!n.collapsed) n.children.forEach((c) => walk(c, d + 1))
  }
  walk(root, 0)
  return out
}

/** dagre 分层布局：LR 左根右叶；节点尺寸取实测值（无则用估计值），保证无重叠 */
export function layoutTree(
  root: KNode,
  manualPos?: Record<string, { x: number; y: number }>,
  sizes?: Map<string, NodeSize>,
): PlacedNode[] {
  const visible: KNode[] = []
  const collect = (n: KNode) => {
    visible.push(n)
    if (!n.collapsed) n.children.forEach(collect)
  }
  collect(root)

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90, marginx: 40, marginy: 40 })
  g.setDefaultEdgeLabel(() => ({}))
  visible.forEach((n) => {
    const s = sizes?.get(n.id)
    g.setNode(n.id, { width: s?.w ?? NODE_W, height: s?.h ?? NODE_H })
  })
  const walkEdges = (n: KNode) => {
    if (!n.collapsed) {
      // dagre 同层排序与插入顺序相反：倒序插入边，使第一个子节点显示在最上方
      const kids = [...n.children].reverse()
      kids.forEach((c) => {
        g.setEdge(n.id, c.id)
        walkEdges(c)
      })
    }
  }
  walkEdges(root)
  dagre.layout(g)

  return visible.map((n) => {
    const p = g.node(n.id)
    const manual = manualPos?.[n.id]
    return {
      node: n,
      x: manual ? manual.x : p.x - NODE_W / 2,
      y: manual ? manual.y : p.y - NODE_H / 2,
    }
  })
}

// ---------------------------------------------------------------------------
// 碰撞解算：保证卡片永不重叠（含拖拽、历史数据、导入数据）
// ---------------------------------------------------------------------------

export interface CollItem {
  id: string
  w: number
  h: number
  x: number
  y: number
  fixed: boolean // 拖拽中的子树成员位置固定，只推别人
}

const GAP_X = 32 // 卡片间最小横向间隙（设计规范）
const GAP_Y = 24 // 卡片间最小纵向间隙

/** 迭代推开重叠对，直到无重叠或达到最大轮数 */
export function resolveCollisions(items: CollItem[], maxPasses = 80): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        if (a.fixed && b.fixed) continue
        const dx = a.x + a.w / 2 - (b.x + b.w / 2)
        const px = (a.w + b.w) / 2 + GAP_X - Math.abs(dx)
        if (px <= 0) continue
        const dy = a.y + a.h / 2 - (b.y + b.h / 2)
        const py = (a.h + b.h) / 2 + GAP_Y - Math.abs(dy)
        if (py <= 0) continue
        moved = true
        const sx = Math.sign(dx) || 1
        const sy = Math.sign(dy) || 1
        if (px < py) {
          if (a.fixed) b.x -= sx * px
          else if (b.fixed) a.x += sx * px
          else { a.x += (sx * px) / 2; b.x -= (sx * px) / 2 }
        } else {
          if (a.fixed) b.y -= sy * py
          else if (b.fixed) a.y += sy * py
          else { a.y += (sy * py) / 2; b.y -= (sy * py) / 2 }
        }
      }
    }
    if (!moved) break
  }
}

/**
 * 最终无重叠位置：布局结果 + 拖拽偏移 → 碰撞解算。
 * 拖拽中的子树整体固定（rigid），其余卡片被推开；无拖拽时也解算，自愈任何来源的重叠。
 */
export function resolvePositions(
  placed: PlacedNode[],
  sizes: Map<string, NodeSize>,
  drag: { id: string; dx: number; dy: number } | null,
): Map<string, { x: number; y: number }> {
  let offsetIds: Set<string> | null = null
  if (drag) {
    const dn = placed.find((p) => p.node.id === drag.id)?.node
    if (dn) {
      offsetIds = new Set([drag.id])
      const collect = (n: KNode) => {
        n.children.forEach((c) => {
          offsetIds!.add(c.id)
          collect(c)
        })
      }
      collect(dn)
    }
  }
  const items: CollItem[] = placed.map((p) => {
    const s = sizes.get(p.node.id) ?? { w: NODE_W, h: NODE_H }
    const o = drag && offsetIds?.has(p.node.id) ? drag : { dx: 0, dy: 0 }
    return {
      id: p.node.id,
      w: s.w,
      h: s.h,
      x: p.x + o.dx,
      y: p.y + o.dy,
      fixed: !!(drag && offsetIds?.has(p.node.id)),
    }
  })
  resolveCollisions(items)
  return new Map(items.map((i) => [i.id, { x: i.x, y: i.y }]))
}
