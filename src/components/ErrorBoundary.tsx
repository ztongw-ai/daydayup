import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null; retries: number }

/**
 * 全局错误边界：渲染异常时不再白屏，显示错误信息与「恢复」按钮。
 * 恢复时通过递增 key 强制整体重挂载（知识树数据在 localStorage，不会丢失）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retries: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[DAYDAYUP] 渲染错误：', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-card">
          <h3>页面渲染出现了一个错误</h3>
          <p className="crash-msg">{this.state.error.message || String(this.state.error)}</p>
          <button className="kbtn kbtn-primary" onClick={() => this.setState((s) => ({ error: null, retries: s.retries + 1 }))}>
            一键恢复（数据不会丢失）
          </button>
        </div>
      )
    }
    return <div key={this.state.retries}>{this.props.children}</div>
  }
}
