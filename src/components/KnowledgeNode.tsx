import { memo, useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { KNode, LearningProfile, NodeStatus } from '../types'
import { widthFor } from '../layout'

/** textarea 高度随内容自适应，封顶 max */
const autoGrow = (el: HTMLTextAreaElement | null, max: number) => {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, max) + 'px'
}

/** 中文输入法组词确认时的回车（keyCode 229 / isComposing）不触发发送 */
const isComposingEnter = (e: React.KeyboardEvent): boolean =>
  (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229

export interface KnowledgeNodeData extends Record<string, unknown> {
  node: KNode
  profile?: LearningProfile
  /** 所在层级（列）的统一宽度，未提供时回退到自身需求宽度 */
  width?: number
  /** 所在层级深度（用于列底色区分） */
  depth?: number
  loading: boolean
  asking: boolean
  onExpand: (id: string) => void
  onAsk: (id: string) => void
  onAskSubmit: (id: string, question: string) => void
  onAskCancel: () => void
  onAskAbort: () => void
  onToggle: (id: string) => void
  onStatus: (id: string, status: NodeStatus) => void
  onSelect: (id: string) => void
  onMeasure: (id: string, size: { w: number; h: number }) => void
}

const STATUS_ICON: Record<NodeStatus, string> = {
  unknown: '○',
  mastered: '✓',
  blind: '!',
}
const STATUS_TITLE: Record<NodeStatus, string> = {
  unknown: '学习状态：未了解（点击切换：已掌握 → 盲区）',
  mastered: '学习状态：已掌握（点击切换：盲区 → 未了解）',
  blind: '学习状态：知识盲区（点击切换：未了解 → 已掌握）',
}
const PRIORITY_BADGE: Record<string, { label: string; cls: string }> = {
  P0: { label: '先学', cls: 'kp0' },
  P1: { label: '重要', cls: 'kp1' },
  P2: { label: '按需', cls: 'kp2' },
}

function KnowledgeNodeInner({ data, selected }: NodeProps) {
  const {
    node, profile, width, depth, loading, asking,
    onExpand, onAsk, onAskSubmit, onAskCancel, onAskAbort,
    onToggle, onStatus, onSelect, onMeasure,
  } = data as KnowledgeNodeData
  const childCount = node.children.length
  const cardRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  // 是否真的被截断：按渲染结果判断（scrollHeight > clientHeight），内容装得下就不显示「全文」
  const [clipped, setClipped] = useState(false)
  const priority = node.priority ? PRIORITY_BADGE[node.priority] : null
  const isRoot = node.kind === 'root'

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    setClipped(el.scrollHeight - el.clientHeight > 2)
  }, [node.content, width, open, asking])

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const report = () => {
      onMeasure(node.id, { w: el.offsetWidth, h: el.offsetHeight })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [node.id, node.content, onMeasure])

  useEffect(() => {
    if (!asking) {
      setQuestion('')
      requestAnimationFrame(() => autoGrow(askRef.current, 96))
    }
  }, [asking])

  const stop =
    <E extends { stopPropagation: () => void }>(fn: () => void) =>
    (e: E) => {
      e.stopPropagation()
      fn()
    }

  const submitAsk = () => {
    const q = question.trim()
    if (!q) return
    onAskSubmit(node.id, q)
  }

  return (
    <div
      ref={cardRef}
      className={`knode knode-${node.kind} knode-status-${node.status}${node.kind === 'standard' ? ` k-depth-${(depth ?? 1) % 3}` : ''}${selected ? ' knode-selected' : ''}`}
      style={{ width: width ?? widthFor(node) }}
    >
      <Handle type="target" position={Position.Left} className="khandle" />
      <div className="knode-head" onClick={stop(() => onSelect(node.id))}>
        {isRoot && <span className="knode-badge knode-badge-dark">档案</span>}
        <span className="knode-title" title={node.title}>{node.title}</span>
        {node.kind === 'question' && <span className="knode-badge">追问</span>}
        {priority && <span className={`kp ${priority.cls}`}>{priority.label}</span>}
      </div>

      {isRoot && profile ? (
        <dl className="knode-profile">
          {profile.goal && <div><dt>学习目标</dt><dd>{profile.goal}</dd></div>}
          {profile.perspective && <div><dt>学习视角</dt><dd>{profile.perspective}</dd></div>}
          {profile.avoid && profile.avoid !== '无' && <div><dt>不必深入</dt><dd>{profile.avoid}</dd></div>}
        </dl>
      ) : (
        <div
          ref={contentRef}
          className={`knode-content${open ? ' knode-content-open' : ''}`}
          onClick={stop(() => onSelect(node.id))}
        >
          {node.content || '—'}
        </div>
      )}
      {!isRoot && (open || clipped) && (
        <button className="kexpand nodrag" onClick={stop(() => setOpen((v) => !v))}>
          {open ? '▲ 收起' : '▼ 全文'}
        </button>
      )}

      <div className="knode-actions">
        <button
          className={`kact nodrag${node.expanded ? ' kact-done' : ''}`}
          disabled={loading || node.expanded}
          title={node.expanded ? '已展开过：去子节点继续' : 'AI 把这个主题分层讲透'}
          onClick={stop(() => onExpand(node.id))}
        >
          {loading ? '展开中…' : node.expanded ? '已展开' : 'ⓘ 展开说说'}
        </button>
        <button
          className="kact kact-ask nodrag"
          disabled={loading}
          title="就这个节点提出你的疑问"
          onClick={stop(() => onAsk(node.id))}
        >
          {asking ? '💬 收起疑问' : '💬 我有疑问'}
        </button>
        <span className="knode-spacer" />
        {childCount > 0 && (
          <button
            className={`kfold nodrag${node.collapsed ? ' kfold-collapsed' : ''}`}
            title={node.collapsed ? `展开 ${childCount} 个子节点` : `折叠此分支（隐藏 ${childCount} 个子节点）`}
            onClick={stop(() => onToggle(node.id))}
          >
            {node.collapsed ? `▸ ${childCount}` : `▾ ${childCount}`}
          </button>
        )}
        <button
          className={`kstatus kstatus-${node.status} nodrag`}
          title={STATUS_TITLE[node.status]}
          onClick={stop(() => {
            const order: NodeStatus[] = ['unknown', 'mastered', 'blind']
            onStatus(node.id, order[(order.indexOf(node.status) + 1) % 3])
          })}
        >
          {STATUS_ICON[node.status]}
        </button>
      </div>

      {asking && (
        <div className="knode-ask nodrag" onClick={(e) => e.stopPropagation()}>
          <div className="knode-ask-row">
            <textarea
              ref={askRef}
              rows={1}
              value={question}
              placeholder="你的疑问…"
              onChange={(e) => {
                setQuestion(e.target.value)
                autoGrow(e.currentTarget, 96)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuestion(''); onAskCancel(); return }
                if (e.key !== 'Enter' || e.shiftKey) return
                if (isComposingEnter(e)) return
                e.preventDefault()
                submitAsk()
              }}
            />
            {loading ? (
              <button className="kbtn kstop" title="停止本次生成，文字保留" onClick={stop(onAskAbort)}>
                ■ 停止
              </button>
            ) : (
              <button
                className="kbtn kbtn-primary"
                disabled={!question.trim()}
                onClick={stop(submitAsk)}
              >
                发送
              </button>
            )}
          </div>
          <div className="kask-hint">
            {loading ? '正在回答…停止后文字原样保留' : 'Enter 发送 · Shift+Enter 换行 · Esc 取消'}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="khandle" />
    </div>
  )
}

export const KnowledgeNode = memo(KnowledgeNodeInner)
