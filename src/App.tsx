import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  MarkerType,
  PanOnScrollMode,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node as FlowNode,
  type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { KnowledgeTree, KNode, NodeStatus, Settings } from './types'
import { findNode, newNode, pathOf, pathNodes, siblingsAround, countNodes, updateNode, uid } from './types'
import {
  loadTrees, saveTrees, loadActiveId, saveActiveId,
  loadSettings, saveSettings, exportTree, importTree,
} from './storage'
import {
  generateTrunk, expandStandard, expandQuestion, distillProfile,
  fallbackProfile, prefsOf, isAbortError,
} from './ai'
import { layoutTree, resolvePositions, levelWidths, levelDepths, NODE_W, NODE_H, type NodeSize } from './layout'
import { KnowledgeNode, type KnowledgeNodeData } from './components/KnowledgeNode'
import { GhostNode } from './components/GhostNode'
import { SuperMap, type MiniCard } from './components/SuperMap'
import { ErrorBoundary } from './components/ErrorBoundary'
import logoUrl from './assets/daydayup-logo.png'

interface Toast { id: string; msg: string }

function App() {
  const [trees, setTrees] = useState<KnowledgeTree[]>(() => loadTrees())
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveId())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showSettings, setShowSettings] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  const [newDomain, setNewDomain] = useState('')
  const [busyNode, setBusyNode] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [askingFor, setAskingFor] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeTree | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const domainRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const migratedRef = useRef<Set<string>>(new Set())
  const prevSelectedRef = useRef<string | null>(null)
  const superRedrawRef = useRef<(() => void) | null>(null)
  const rf = useReactFlow()
  // 卡片实测尺寸（自适应高度/宽度）：id → {w,h}，供布局引擎使用
  const sizesRef = useRef<Map<string, NodeSize>>(new Map())
  const [sizesVersion, setSizesVersion] = useState(0)
  // 画布空白 bug 的根因与对策（React Flow v12 adoptUserNodes）：
  // 受控节点对象引用一变，RF 就丢弃自己的内部测量、改从 userNode.measured 读取；
  // 读不到就把节点渲染成 visibility:hidden。因此 measured 必须在「构建节点对象的当下」
  // 同步拿得到——绝不能靠 effect 里回填（那样永远慢一帧，且当尺寸未变、不触发重渲染时
  // 永远补不回来，表现为切换知识树后必须刷新才显示）。
  // sizesRef 由卡片自身的 ResizeObserver 写入，是尺寸的唯一真源，直接用它即可。
  const onMeasure = useCallback((id: string, size: NodeSize) => {
    const prev = sizesRef.current.get(id)
    if (prev && Math.abs(prev.h - size.h) < 0.5 && Math.abs(prev.w - size.w) < 0.5) return
    sizesRef.current.set(id, size)
    setSizesVersion((v) => v + 1)
  }, [])

  const tree = trees.find((t) => t.id === activeId) ?? null
  const treesRef = useRef(trees)
  treesRef.current = trees

  const pushToast = useCallback((msg: string) => {
    const t = { id: uid(), msg }
    setToasts((prev) => [...prev.slice(-2), t])
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 4000)
  }, [])
  const setError = pushToast

  useEffect(() => { saveTrees(trees) }, [trees])
  useEffect(() => { saveActiveId(activeId) }, [activeId])
  useEffect(() => { saveSettings(settings) }, [settings])
  useEffect(() => {
    const el = domainRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [newDomain])
  // 详情抽屉打开时画布视口左移 230px，把选中卡推到可见区
  useEffect(() => {
    const opened = selectedId && !prevSelectedRef.current
    prevSelectedRef.current = selectedId
    if (opened) {
      const vp = rf.getViewport()
      rf.setViewport({ ...vp, x: vp.x - 230 }, { duration: 220 })
    }
  }, [selectedId, rf])

  // 切换知识树后显式重新拟合视口。
  // 不能依赖 React Flow 的 fitView prop——它只在初始化时生效；也不能依赖「节点首次测量完成」
  // 触发的附带重拟合——尺寸命中缓存时那条路径根本不会跑，视口便停留在上一棵树的位置，
  // 表现为「切过去画布一片空白，刷新才有」。
  useEffect(() => {
    if (!activeId) return
    let raf2 = 0
    // 等布局与测量落定后再拟合（两帧足够 dagre 结果与卡片实测尺寸提交完成）
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => rf.fitView({ padding: 0.25, duration: 400 }))
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [activeId, rf])

  const patchTree = useCallback(
    (fn: (t: KnowledgeTree) => KnowledgeTree) => {
      setTrees((prev) =>
        prev.map((t) => (t.id === activeId ? { ...fn(t), updatedAt: Date.now() } : t)),
      )
    },
    [activeId],
  )

  // ---------- 旧树档案回填 ----------
  useEffect(() => {
    const t = trees.find((x) => x.id === activeId)
    if (!t || t.profile || t.domain.length <= 30 || generating || busyNode) return
    if (migratedRef.current.has(t.id)) return
    migratedRef.current.add(t.id)
    ;(async () => {
      try {
        const profile = await distillProfile(settings, t.domain)
        setTrees((prev) =>
          prev.map((x) => {
            if (x.id !== t.id || x.profile) return x
            return { ...x, domain: profile.domain, profile, root: { ...x.root, title: profile.domain } }
          }),
        )
      } catch {
        migratedRef.current.delete(t.id)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, trees, generating, busyNode])

  // ---------- 生成知识树（两步：档案提炼 → 定制主干） ----------
  const createTree = async () => {
    const raw = newDomain.trim()
    if (!raw) return
    setGenerating(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const profile = await distillProfile(settings, raw, ctrl.signal)
      const children = await generateTrunk(settings, profile, prefsOf(settings), ctrl.signal)
      const root = newNode({
        title: profile.domain,
        kind: 'root',
        expanded: true,
        content: profile.goal,
        children: children.map((c) =>
          newNode({
            title: c.title, content: c.content, kind: 'standard',
            priority: c.priority === 'P0' || c.priority === 'P1' || c.priority === 'P2' ? c.priority : undefined,
          }),
        ),
      })
      const t: KnowledgeTree = {
        id: uid(), domain: profile.domain, createdAt: Date.now(), updatedAt: Date.now(),
        root, profile, manualPos: {},
      }
      setTrees((prev) => [...prev, t])
      setActiveId(t.id)
      setNewDomain('')
      setTimeout(() => rf.fitView({ padding: 0.25, duration: 600 }), 350)
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
      abortRef.current = null
    }
  }

  // ---------- 模式A：进一步解释 ----------
  const handleExpand = useCallback(async (id: string) => {
    const t = treesRef.current.find((x) => x.id === activeId)
    const target = t ? findNode(t.root, id) : null
    if (!t || !target) return
    if (abortRef.current) { pushToast('上一个生成还在进行中，请等它完成或先停止'); return }
    setBusyNode(id)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const profile = t.profile ?? fallbackProfile(t.domain)
      const children = await expandStandard(
        settings, profile, pathOf(t.root, id), target.title, target.content, prefsOf(settings), ctrl.signal,
      )
      setTrees((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                updatedAt: Date.now(),
                root: updateNode(x.root, id, (n) => {
                  n.children.push(
                    ...children.map((c) =>
                      newNode({ title: c.title, content: c.content, kind: 'standard', parentId: id, expandedFrom: 'A标准下探' }),
                    ),
                  )
                  n.expanded = true
                  n.collapsed = false
                }),
              }
            : x,
        ),
      )
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyNode(null)
      abortRef.current = null
    }
  }, [activeId, settings, setError])

  // ---------- 模式B：追问 ----------
  const submitQuestion = async (id: string, q: string) => {
    const t = treesRef.current.find((x) => x.id === activeId)
    const target = t ? findNode(t.root, id) : null
    if (!t || !target) return
    if (abortRef.current) { pushToast('上一个生成还在进行中，请等它完成或先停止'); return }
    setBusyNode(id)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const profile = t.profile ?? fallbackProfile(t.domain)
      const { answer, children } = await expandQuestion(
        settings, profile, pathOf(t.root, id), target.title, q, prefsOf(settings), ctrl.signal,
      )
      setTrees((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                updatedAt: Date.now(),
                root: updateNode(x.root, id, (n) => {
                  n.children.push(newNode({
                    title: q.length > 24 ? `${q.slice(0, 24)}…` : q,
                    content: answer,
                    kind: 'question',
                    parentId: id,
                    question: q,
                    expandedFrom: 'B疑问下探',
                    children: children.map((c) =>
                      newNode({ title: c.title, content: c.content, kind: 'standard', expandedFrom: 'B疑问下探' }),
                    ),
                  }))
                  n.collapsed = false
                }),
              }
            : x,
        ),
      )
      setAskingFor(null)
    } catch (e) {
      if (!isAbortError(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyNode(null)
      abortRef.current = null
    }
  }

  const handleToggle = useCallback((id: string) => {
    setTrees((prev) =>
      prev.map((x) =>
        x.id === activeId
          ? { ...x, updatedAt: Date.now(), root: updateNode(x.root, id, (n) => { n.collapsed = !n.collapsed }) }
          : x,
      ),
    )
  }, [activeId])

  const handleStatus = useCallback((id: string, status: NodeStatus) => {
    setTrees((prev) =>
      prev.map((x) =>
        x.id === activeId
          ? { ...x, updatedAt: Date.now(), root: updateNode(x.root, id, (n) => { n.status = status }) }
          : x,
      ),
    )
  }, [activeId])

  const startAsk = useCallback((id: string) => {
    setAskingFor((prev) => (prev === id ? null : id))
  }, [])

  // ---------- 拖拽：整棵子树跟随，松手固化无重叠终态 ----------
  const onNodeDragStart: OnNodeDrag = useCallback((_event, node) => {
    dragStartRef.current = node.position
    setDrag({ id: node.id, dx: 0, dy: 0 })
  }, [])

  const onNodeDrag: OnNodeDrag = useCallback((_event, node) => {
    const start = dragStartRef.current
    if (!start) return
    setDrag((prev) =>
      prev && prev.id === node.id
        ? { ...prev, dx: node.position.x - start.x, dy: node.position.y - start.y }
        : prev,
    )
  }, [])

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node) => {
      const delta = drag
      const t = treesRef.current.find((x) => x.id === activeId)
      setDrag(null)
      dragStartRef.current = null
      if (!t) return
      const placed = layoutTree(t.root, t.manualPos, sizesRef.current)
      const resolved = resolvePositions(placed, sizesRef.current, delta)
      const updates: Record<string, { x: number; y: number }> = {}
      resolved.forEach((p, id) => { updates[id] = p })
      setTrees((prev) =>
        prev.map((x) =>
          x.id === t.id ? { ...x, manualPos: updates, updatedAt: Date.now() } : x,
        ),
      )
    },
    [drag, activeId],
  )

  // ---------- 画布节点与边 ----------
  const callbacks = useMemo(
    () => ({
      onExpand: handleExpand,
      onAsk: startAsk,
      onAskSubmit: submitQuestion,
      onAskCancel: () => setAskingFor(null),
      onAskAbort: () => abortRef.current?.abort(),
      onToggle: handleToggle,
      onStatus: handleStatus,
      onSelect: setSelectedId,
      onMeasure,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleExpand, startAsk, handleToggle, handleStatus, settings, activeId],
  )

  const basePlaced = useMemo(() => {
    if (!tree) return null
    return layoutTree(tree.root, tree.manualPos, sizesRef.current)
  }, [tree, sizesVersion])

  const positions = useMemo(
    () => resolvePositions(basePlaced ?? [], sizesRef.current, drag),
    [basePlaced, drag, sizesVersion],
  )

  // 节点对象缓存：内容未变化的节点复用同一对象引用，
  // 使 React Flow 走 adoption 快路径保留测量状态（彻底消除 visibility:hidden 竞态）
  const nodeCacheRef = useRef(new Map<string, {
    fnode: FlowNode
    src: KNode
    profile?: unknown
    width?: number
    depth?: number
    loading: boolean
    asking: boolean
    callbacks: unknown
    mw?: number
    mh?: number
    className?: string
    x: number
    y: number
  }>())
  const cacheTreeIdRef = useRef<string | null>(null)
  if (tree && cacheTreeIdRef.current !== tree.id) {
    cacheTreeIdRef.current = tree.id
    nodeCacheRef.current.clear()
  }

  const { flowNodes, edges } = useMemo(() => {
    if (!tree || !basePlaced) return { flowNodes: [] as FlowNode[], edges: [] as Edge[] }
    // 被拖子树成员标记 k-rigid（关闭让位动画，刚体跟随）
    let rigidIds: Set<string> | null = null
    if (drag) {
      const dn = findNode(tree.root, drag.id)
      if (dn) {
        rigidIds = new Set([drag.id])
        const collect = (n: KNode) => n.children.forEach((c) => { rigidIds!.add(c.id); collect(c) })
        collect(dn)
      }
    }

    // 每列（层级）统一宽度：取该层最大需求宽度，同列等宽对齐
    const levelW = levelWidths(tree.root)
    const depths = levelDepths(tree.root)
    const cache = nodeCacheRef.current

    const flowNodes: FlowNode[] = basePlaced.map(({ node }) => {
      const pos = positions.get(node.id) ?? { x: 0, y: 0 }
      const cls = rigidIds?.has(node.id) ? 'k-rigid' : undefined
      const profileVal = node.kind === 'root' ? tree.profile : undefined
      const widthVal = levelW.get(node.id)
      const depthVal = depths.get(node.id)
      const loadingVal = busyNode === node.id
      const askingVal = askingFor === node.id
      // 已实测的尺寸同步喂给 RF，节点对象重建时测量不丢失
      const size = sizesRef.current.get(node.id)
      const c = cache.get(node.id)
      if (
        c && c.src === node && c.profile === profileVal && c.width === widthVal &&
        c.depth === depthVal && c.loading === loadingVal && c.asking === askingVal &&
        c.callbacks === callbacks && c.mw === size?.w && c.mh === size?.h &&
        c.className === cls && c.x === pos.x && c.y === pos.y
      ) {
        return c.fnode
      }
      const fnode: FlowNode = {
        id: node.id,
        type: 'knowledge',
        position: { x: pos.x, y: pos.y },
        className: cls,
        measured: size ? { width: size.w, height: size.h } : undefined,
        // 兜底：尚未实测的新节点也给出估计尺寸，使 nodeHasDimensions 恒为真，
        // RF 永远不会把卡片藏成 visibility:hidden（实测到位后 RF 自动弃用 initial*）
        initialWidth: widthVal ?? NODE_W,
        initialHeight: NODE_H,
        data: {
          node,
          profile: profileVal,
          width: widthVal,
          depth: depthVal,
          loading: loadingVal,
          asking: askingVal,
          ...callbacks,
        } as KnowledgeNodeData,
      }
      cache.set(node.id, {
        fnode, src: node, profile: profileVal, width: widthVal, depth: depthVal,
        loading: loadingVal, asking: askingVal, callbacks, mw: size?.w, mh: size?.h,
        className: cls, x: pos.x, y: pos.y,
      })
      return fnode
    })

    const mkEdge = (source: string, target: string, kind: KNode['kind'], animated: boolean): Edge =>
      kind === 'question'
        ? {
            id: `${source}-${target}`,
            source, target,
            type: 'smoothstep',
            animated,
            style: { stroke: 'var(--amber)', strokeWidth: 1.8 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 6, height: 6, color: 'var(--amber)' },
          }
        : {
            id: `${source}-${target}`,
            source, target,
            type: 'smoothstep',
            animated,
            style: { stroke: 'var(--line)', strokeWidth: 1.6 },
          }

    const edges: Edge[] = []
    const walk = (n: KNode) => {
      if (!n.collapsed) {
        for (const c of n.children) {
          edges.push(mkEdge(n.id, c.id, c.kind, busyNode === n.id))
          walk(c)
        }
      }
    }
    walk(tree.root)

    // 呼吸占位卡：两张错开 0.5s，形成波次
    if (busyNode) {
      const p = positions.get(busyNode)
      if (p) {
        const w = sizesRef.current.get(busyNode)?.w ?? NODE_W
        const baseX = p.x + w + 48
        flowNodes.push(
          {
            id: `ghost-${busyNode}`,
            type: 'ghost',
            position: { x: baseX, y: p.y },
            draggable: false, selectable: false, deletable: false,
            data: {},
          },
          {
            id: `ghost2-${busyNode}`,
            type: 'ghost',
            position: { x: baseX, y: p.y + 140 },
            className: 'kghost-2',
            draggable: false, selectable: false, deletable: false,
            data: {},
          },
        )
        edges.push({
          id: `ghost-e-${busyNode}`,
          source: busyNode,
          target: `ghost-${busyNode}`,
          type: 'smoothstep',
          className: 'kedge-ghost',
          style: { stroke: 'var(--blue)', strokeWidth: 1.6, strokeDasharray: '6 6' },
        })
      }
    }
    return { flowNodes, edges }
  }, [tree, basePlaced, positions, callbacks, busyNode, askingFor, drag, sizesVersion])

  // 超级缩略图数据：真实位置/尺寸/层级色
  const miniCards = useMemo<MiniCard[]>(() => {
    if (!tree || !basePlaced) return []
    const depths = levelDepths(tree.root)
    return basePlaced.map(({ node, x, y }) => {
      const p = positions.get(node.id)
      const s = sizesRef.current.get(node.id) ?? { w: NODE_W, h: 140 }
      return {
        id: node.id,
        x: p?.x ?? x,
        y: p?.y ?? y,
        w: s.w,
        h: s.h,
        kind: node.kind,
        status: node.status,
        depth: depths.get(node.id) ?? 1,
      }
    })
  }, [tree, basePlaced, positions, sizesVersion])

  const tidyLayout = () => {
    patchTree((t) => ({ ...t, manualPos: {} }))
    setTimeout(() => rf.fitView({ padding: 0.25, duration: 600 }), 50)
  }

  const locateNode = (id: string) => {
    rf.fitView({ nodes: [{ id }], duration: 450, maxZoom: 1, padding: 1.5 })
  }

  const selected = tree && selectedId ? findNode(tree.root, selectedId) : null
  const selectedPath = tree && selectedId ? pathNodes(tree.root, selectedId) : []
  const sib = tree && selected ? siblingsAround(tree.root, selected.id) : null

  const confirmDelete = () => {
    if (!deleteTarget) return
    setTrees((prev) => prev.filter((t) => t.id !== deleteTarget.id))
    if (activeId === deleteTarget.id) setActiveId(null)
    setDeleteTarget(null)
  }

  // ---------- 渲染 ----------
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sb-scroll">
          <div className="brand">
            <img className="brand-logo" src={logoUrl} alt="DaydayUP" />
            <span className="brand-tag">好好学习 · 天天向上</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              ref={domainRef}
              className="domain-input"
              rows={3}
              value={newDomain}
              placeholder={'输入你想要了解的领域，或学习的目的…'}
              onChange={(e) => {
                setNewDomain(e.target.value)
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 200) + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return
                const ne = e.nativeEvent as KeyboardEvent
                if (ne.isComposing || e.keyCode === 229) return
                e.preventDefault()
                createTree()
              }}
            />
            {generating ? (
              <button className="kbtn kstop kbtn-block" onClick={() => abortRef.current?.abort()}>
                ■ 停止生成（输入已保留）
              </button>
            ) : (
              <button className="kbtn kbtn-primary kbtn-block" disabled={!newDomain.trim()} onClick={createTree}>
                生成知识树
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="prefs-toggle" onClick={() => setShowPrefs((v) => !v)}>
              生成偏好
              <span className="sb-optional">可选 {showPrefs ? '▲' : '▼'}</span>
            </button>
            {showPrefs && (
              <div className="prefs">
                <label>讲解深度
                  <select value={settings.depth}
                    onChange={(e) => setSettings({ ...settings, depth: e.target.value as Settings['depth'] })}>
                    <option value="beginner">零基础友好</option>
                    <option value="intermediate">系统进阶</option>
                    <option value="expert">专业硬核</option>
                  </select>
                </label>
                <label>讲解口吻
                  <select value={settings.tone}
                    onChange={(e) => setSettings({ ...settings, tone: e.target.value as Settings['tone'] })}>
                    <option value="teacher">导师讲解</option>
                    <option value="doc">技术文档</option>
                    <option value="practitioner">从业者实战</option>
                  </select>
                </label>
                <div className="prefs-bg-row">
                  <label>你的背景 · 从你熟悉的领域扩展
                    <input className="prefs-bg" value={settings.background}
                      placeholder=""
                      onChange={(e) => setSettings({ ...settings, background: e.target.value })} />
                  </label>
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="sb-label">知识树 · {trees.length}</span>
            <ul className="tree-list">
              {trees.map((t) => (
                <li key={t.id} className={t.id === activeId ? 'active' : ''}>
                  <span className="tree-name" onClick={() => {
                    setActiveId(t.id); setSelectedId(null); setAskingFor(null); setDrag(null); dragStartRef.current = null
                    setTimeout(() => rf.fitView({ padding: 0.25, duration: 600 }), 50)
                  }}>
                    <b>{t.domain}</b>
                    <em>{countNodes(t.root)} 节点</em>
                  </span>
                  <button title="导出 JSON 备份" onClick={() => exportTree(t)}>⬇</button>
                  <button className="kdel" title="删除" onClick={() => setDeleteTarget(t)}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="sb-bottom">
          <button className="kbtn kbtn-block" onClick={() => fileRef.current?.click()}>导入知识树 JSON</button>
          <input
            ref={fileRef} type="file" accept=".json" hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              try {
                const t = await importTree(f)
                setTrees((prev) => [...prev, t])
                setActiveId(t.id)
              } catch (err) {
                pushToast(err instanceof Error ? err.message : String(err))
              }
              e.target.value = ''
            }}
          />
          <button className="kbtn kbtn-block" onClick={() => setShowSettings((v) => !v)}>
            设置 · API 配置 {showSettings ? '▲' : '▼'}
          </button>
          {showSettings && (
            <div className="settings">
              <label>API Key
                <input type="password" value={settings.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} />
              </label>
              <label>Base URL
                <input value={settings.baseUrl}
                  onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} />
              </label>
              <label>模型名
                <input value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })} />
              </label>
              <p className="hint">配置已通过本地 .env.local 自动注入，仅存于本地浏览器，不会上传。</p>
            </div>
          )}
        </div>
      </aside>

      <main className="canvas">
        {tree ? (
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            nodeTypes={{ knowledge: KnowledgeNode, ghost: GhostNode }}
            fitView
            minZoom={0.1}
            maxZoom={4}
            /* Figma 式交互：双指滑动平移（任意方向）；捏合 / Ctrl+滚轮缩放 */
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            zoomOnPinch
            panOnDrag
            onMove={() => superRedrawRef.current?.()}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => { setSelectedId(null); setAskingFor(null) }}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#dcd6c8" />
            <Controls showInteractive={false} />
            <Panel position="bottom-right">
              <SuperMap cards={miniCards} onReady={(fn) => { superRedrawRef.current = fn }} />
            </Panel>
            <Panel position="top-left" className="canvas-toolbar">
              <button className="kbtn" onClick={tidyLayout}>⟲ 整理布局</button>
              <button className="kbtn kbtn-ink" onClick={() => rf.fitView({ padding: 0.25, duration: 500 })}>⤢ 全局总览</button>
            </Panel>
          </ReactFlow>
        ) : (
          <div className="empty">
            {generating ? (
              <>
                <p>✨ 正在理解你的学习需求并搭建领域骨架…</p>
                <small>通常 30~60 秒</small>
              </>
            ) : (
              <>
                <p>{trees.length === 0 ? '输入学习领域或目标，生成你的第一棵知识树' : '从左侧选择一棵知识树'}</p>
                {trees.length === 0 && <small>写清「学完要能做什么」，AI 会先提炼你的学习档案，整棵树都按这个目标定制</small>}
              </>
            )}
          </div>
        )}

        {selected && (
          <aside className="detail-drawer">
            <div className="detail-head">
              {sib && sib.total > 0 && (
                <div className="detail-nav">
                  <button
                    disabled={!sib.prev}
                    title="上一条（同层级）"
                    onClick={() => { if (sib.prev) { setSelectedId(sib.prev.id); locateNode(sib.prev.id) } }}
                  >‹</button>
                  <span>{sib.index + 1}/{sib.total}</span>
                  <button
                    disabled={!sib.next}
                    title="下一条（同层级）"
                    onClick={() => { if (sib.next) { setSelectedId(sib.next.id); locateNode(sib.next.id) } }}
                  >›</button>
                </div>
              )}
              <button className="close" onClick={() => setSelectedId(null)}>✕</button>
              <div className="detail-path">
                {selectedPath.map((p, i) => (
                  <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {i > 0 && <span className="sep">/</span>}
                    <button
                      title={p.title}
                      onClick={() => { setSelectedId(p.id); locateNode(p.id) }}
                    >
                      {p.title.length > 10 ? `${p.title.slice(0, 10)}…` : p.title}
                    </button>
                  </span>
                ))}
              </div>
              <div className="detail-meta">
                <span>{selected.kind === 'root' ? '学习领域' : selected.kind === 'question' ? '追问分支' : '知识点'}</span>
                <span>{selected.children.length} 个子节点</span>
                {selected.priority && <span>{selected.priority === 'P0' ? '先学' : selected.priority === 'P1' ? '重要' : '按需'}</span>}
                <button
                  className="kmeta-status"
                  title="点击切换学习状态"
                  onClick={() => {
                    const order: NodeStatus[] = ['unknown', 'mastered', 'blind']
                    handleStatus(selected.id, order[(order.indexOf(selected.status) + 1) % 3])
                  }}
                >
                  {selected.status === 'unknown' ? '○ 未了解' : selected.status === 'mastered' ? '✓ 已掌握' : '! 盲区'}
                </button>
              </div>
            </div>
            <div className="detail-body">
              {selected.question && <div className="detail-q">原始追问：{selected.question}</div>}
              <h2 className="detail-title">{selected.title}</h2>
              <p className="detail-content">{selected.content || '（暂无内容，可对该节点展开说说或提问）'}</p>
            </div>
            <div className="detail-foot">
              <button
                className="kbtn"
                disabled={selected.expanded || busyNode === selected.id}
                title={selected.expanded ? '已展开过：去子节点继续' : 'AI 把这个主题分层讲透'}
                onClick={() => handleExpand(selected.id)}
              >ⓘ 展开说说</button>
              <button
                className="kbtn"
                disabled={busyNode === selected.id}
                title="在卡片上打开疑问输入框"
                onClick={() => { locateNode(selected.id); setAskingFor(selected.id) }}
              >💬 我有疑问</button>
              <button className="kbtn kbtn-ink" onClick={() => locateNode(selected.id)}>在画布中定位</button>
            </div>
          </aside>
        )}
      </main>

      {deleteTarget && (
        <div className="modal-mask" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除「{deleteTarget.domain}」？</h3>
            <p>该树的 {countNodes(deleteTarget.root)} 个节点将被一并删除，不可恢复。建议先导出 JSON 备份。</p>
            <div className="modal-btns">
              <button className="kbtn" onClick={() => { exportTree(deleteTarget); setDeleteTarget(null) }}>先导出备份</button>
              <button className="kbtn kbtn-danger" onClick={confirmDelete}>确认删除</button>
            </div>
            <div className="modal-btns">
              <button className="kbtn" onClick={() => setDeleteTarget(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toast-wrap">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span>{t.msg}</span>
              <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AppRoot() {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </ErrorBoundary>
  )
}
