import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 自托管字体：思源宋/黑 + JetBrains Mono（中文不足字重不用合成加粗）
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'
import '@fontsource/noto-serif-sc/500.css'
import '@fontsource/noto-serif-sc/600.css'
import '@fontsource/noto-serif-sc/700.css'
import '@fontsource/jetbrains-mono/400.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
