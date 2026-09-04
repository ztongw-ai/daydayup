import { memo, useCallback, useEffect, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { KNode } from '../types'

export interface MiniCard {
  id: string
  x: number
  y: number
  w: number
  h: number
  kind: KNode['kind']
  status: string
  depth: number
}

/** 层级绿色系（与画布列底色呼应），根墨黑、追问琥珀为特例 */
const DEPTH_FILL = ['#2e5d4e', '#4b7362', '#6f8f7d', '#93ab98', '#b7c7b3']

/** 画布的「超级缩略图」：按真实卡片位置/尺寸/层级色在 Canvas 上重绘整棵树 + 视口框，可点击跳转 */
function SuperMapInner({ cards, onReady }: { cards: MiniCard[]; onReady?: (redraw: () => void) => void }) {
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const rf = useReactFlow()

  /** 世界坐标 → 缩略图坐标的变换（draw 与点击跳转共用） */
  const transform = useCallback(() => {
    const cvs = cvsRef.current
    if (!cvs || cards.length === 0) return null
    const W = cvs.clientWidth
    const H = cvs.clientHeight
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of cards) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h)
    }
    const pad = 8
    const s = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY))
    const ox = pad - minX * s + (W - pad * 2 - (maxX - minX) * s) / 2
    const oy = pad - minY * s + (H - pad * 2 - (maxY - minY) * s) / 2
    return { W, H, s, ox, oy }
  }, [cards])

  const draw = useCallback(() => {
    const cvs = cvsRef.current
    const ctx = cvs?.getContext('2d')
    const t = transform()
    if (!cvs || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = cvs.clientWidth, H = cvs.clientHeight
    cvs.width = W * dpr
    cvs.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!t) return

    for (const c of cards) {
      const x = c.x * t.s + t.ox
      const y = c.y * t.s + t.oy
      const w = Math.max(c.w * t.s, 2.5)
      const h = Math.max(c.h * t.s, 2)
      const fill =
        c.kind === 'root' ? '#1b1a16'
        : c.kind === 'question' ? '#b8842b'
        : c.status === 'blind' ? '#b3352b'
        : c.status === 'mastered' ? '#2e5d4e'
        : DEPTH_FILL[(c.depth - 1 + DEPTH_FILL.length * 4) % DEPTH_FILL.length]
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        const r = Math.min(2, w / 4, h / 4)
        ctx.roundRect(x, y, w, h, r)
        ctx.fillStyle = fill
        ctx.fill()
      } else {
        ctx.fillStyle = fill
        ctx.fillRect(x, y, w, h)
      }
      // 标题条：给缩略图一种「真实页面」的文档质感
      if (w > 14 && h > 9) {
        ctx.fillStyle = 'rgba(255,255,255,.5)'
        ctx.fillRect(x + 1.5, y + h * 0.2, (w - 3) * 0.68, Math.max(1, h * 0.13))
      }
    }

    // 当前视口框
    const host = cvs.closest('.canvas') as HTMLElement | null
    if (host) {
      const vp = rf.getViewport()
      const vw = host.clientWidth / vp.zoom
      const vh = host.clientHeight / vp.zoom
      const vx = (-vp.x / vp.zoom) * t.s + t.ox
      const vy = (-vp.y / vp.zoom) * t.s + t.oy
      ctx.strokeStyle = '#b3352b'
      ctx.lineWidth = 1.2
      ctx.strokeRect(vx, vy, vw * t.s, vh * t.s)
    }
  }, [cards, rf, transform])

  // 结构/尺寸变化时重绘；对外暴露重绘方法（App 在视口移动时调用）
  useEffect(() => { draw() })
  useEffect(() => { onReady?.(() => draw()) }, [onReady, draw])

  const jump = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cvs = cvsRef.current
    const t = transform()
    if (!cvs || !t) return
    const rect = cvs.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const wx = (mx - t.ox) / t.s
    const wy = (my - t.oy) / t.s
    const host = cvs.closest('.canvas') as HTMLElement | null
    if (!host) return
    const zoom = rf.getViewport().zoom
    rf.setViewport(
      { zoom, x: host.clientWidth / 2 - wx * zoom, y: host.clientHeight / 2 - wy * zoom },
      { duration: 200 },
    )
  }

  return (
    <div className="supermap">
      <canvas ref={cvsRef} onClick={jump} title="点击跳转到对应位置" />
    </div>
  )
}

export const SuperMap = memo(SuperMapInner)
