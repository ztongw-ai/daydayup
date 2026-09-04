import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

/** 生成中的呼吸占位卡片：挂在正在下探的节点右侧，提示 AI 正在工作 */
function GhostNodeInner(_props: NodeProps) {
  return (
    <div className="kghost">
      <Handle type="target" position={Position.Left} className="khandle" />
      <div className="kghost-bar" />
      <div className="kghost-bar kghost-bar-2" />
      <div className="kghost-label">✨ AI 正在生成…</div>
      <Handle type="source" position={Position.Right} className="khandle" />
    </div>
  )
}

export const GhostNode = memo(GhostNodeInner)
