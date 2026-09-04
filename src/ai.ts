import type { Settings, Depth, Tone, LearningProfile } from './types'

interface AiChild {
  title: string
  content: string
  priority?: 'P0' | 'P1' | 'P2'
}

export interface Prefs {
  depth: Depth
  tone: Tone
  /** 学习者已有背景（熟悉领域/技能），用于生成贴切类比；可为空 */
  background: string
}

export const prefsOf = (s: Settings): Prefs => ({
  depth: s.depth,
  tone: s.tone,
  background: s.background,
})

const DEPTH_DESC: Record<Depth, string> = {
  beginner:
    '读者是零基础自学者：先用直觉与类比讲明白，再引入专业术语，术语首次出现时顺带一句通俗解释；',
  intermediate:
    '读者已有一定基础：直入主题，讲清机制与因果关系，正常使用专业术语；',
  expert:
    '读者是专业人士：使用标准术语与严格表述，保留关键定量细节、边界条件与工程权衡；',
}

const TONE_DESC: Record<Tone, string> = {
  teacher: '口吻像耐心的导师：讲清动机（为什么需要它），层层引导、循循善诱。',
  doc: '口吻像严谨的技术文档：精确、克制、条理清晰。',
  practitioner: '口吻像资深从业者聊实战：结合真实使用场景、常见坑与经验判断。',
}

const styleBlock = (p: Prefs) =>
  `${DEPTH_DESC[p.depth]}${TONE_DESC[p.tone]}\n学习者背景：${p.background?.trim() || '未知'}——打比方时优先从这个背景里取材${p.background?.trim() ? '' : '，其次用日常生活经验'}。`

const SYSTEM_PROMPT = `你是一位顶级的一对一导师，服务用户的陌生领域系统自学。你的目标是让学习者「在无形中学到知识」——读完自然就懂了，而不是被名词轰炸：
1. 学习者默认是该领域的零基础小白：任何新概念先用一个贴切的比喻或生活场景引入，让读者凭直觉「懂个大概」，再给出术语与精确表述；术语永远只是直觉的收口，不是起点。
2. 做类比时优先借用学习者已熟悉领域的东西（见「学习者背景」），其次用日常生活经验；比喻要真正贴切，不为比喻而比喻。
3. 你的输出是「从 0 到 1 到 100」的渐进讲义：先建立直觉（0→1），再讲机制与原理（1→10），需要时才深入专业细节（10→100），层次由浅入深。
4. 同层级的节点合起来要构成对一个问题的完整、有条理的回答，节点顺序就是讲解顺序；节点标题尽量口语化、像讲解的小节标题，而不是干巴巴的术语。
5. 每个节点内容自然成文、长短随内容需要，不追求篇幅统一；严禁词典式孤立定义，严禁把无关名词罗列成清单，严禁空话套话。
6. 严格输出 JSON，不输出 JSON 以外的任何文字。`

async function chat(
  settings: Settings,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!settings.apiKey) throw new Error('未配置 API Key，请先在设置中填写')
  const res = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API 请求失败（${res.status}）：${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

/** 从模型输出中提取 JSON（容忍代码块包裹与前后杂质） */
function extractJson<T>(raw: string): T {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.search(/[[{]/)
  if (start > 0) text = text.slice(start)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('AI 输出无法解析为 JSON，请重试。原始输出：' + raw.slice(0, 200))
  }
}

export const isAbortError = (e: unknown) =>
  e instanceof Error && e.name === 'AbortError'

/** 第一步：从用户原始需求提炼「学习档案」，驱动整棵知识树的生成 */
export async function distillProfile(
  settings: Settings,
  raw: string,
  signal?: AbortSignal,
): Promise<LearningProfile> {
  const prompt = `用户的原始学习需求如下：
「${raw}」
请把它提炼为一份「学习档案」，用于定制整个知识树。要求：
- domain：凝练的领域名（10~20 字，如「开源生态入门 × 个人项目上架」），将作为知识树和根节点的名字
- learner：学习者画像——已有的背景/技能/认知（含熟悉的相邻领域），以及明确不懂的部分
- goal：学习目标——学完之后要能做成什么事，尽量具体到动作与场景
- perspective：学习视角——以什么身份/目的来学（如商务解决方案视角、生产实操视角、应试视角），并指出与该视角不匹配、不必深入的方面
- avoid：明确不需要学的（原文没有可推断就写「无」）
只输出 JSON：{"domain":"...","learner":"...","goal":"...","perspective":"...","avoid":"..."}`
  const raw2 = await chat(settings, prompt, signal)
  const p = extractJson<Partial<LearningProfile>>(raw2)
  if (!p.domain) throw new Error('档案提炼失败：缺少 domain')
  return {
    domain: p.domain,
    learner: p.learner ?? '',
    goal: p.goal ?? '',
    perspective: p.perspective ?? '',
    avoid: p.avoid || '无',
    raw,
  }
}

/** 旧树无档案时的兜底档案 */
export const fallbackProfile = (domain: string): LearningProfile => ({
  domain,
  learner: '（未提供，从领域通用角度讲解）',
  goal: '系统性掌握该领域并建立完整知识体系',
  perspective: '系统学习视角',
  avoid: '无',
  raw: domain,
})

/** 领域一级主干生成（基于学习档案定制，含学习优先级） */
export async function generateTrunk(
  settings: Settings,
  profile: LearningProfile,
  prefs: Prefs,
  signal?: AbortSignal,
): Promise<AiChild[]> {
  const prompt = `学习档案（这是为一位具体学习者定制的知识树，不是通用领域百科）：
- 领域：${profile.domain}
- 学习者：${profile.learner}
- 学习目标：${profile.goal}
- 学习视角：${profile.perspective}
- 不必深入：${profile.avoid}
${styleBlock(prefs)}
请回答：要达成这个学习目标，应该按怎样的脉络学？
把你的回答整理为 6~10 个一级主干节点，按学习的逻辑顺序排列：
- 既要覆盖领域的核心骨架，也必须包含为达成目标而定制的模块（例如与目标直接相关的行业格局、产品能力、客户与商业知识——按目标实际情况取舍）
- 明确避开「不必深入」的部分
- 每个节点标注 priority：P0=达成目标的第一优先（先学）、P1=重要支撑、P2=按需了解
- 每个主干 content 用自然的话讲清这一步学什么、为什么放在这个位置（1~3 句，长短随需要）
输出 JSON 数组：
[{"title": "...", "content": "...", "priority": "P0"}]`
  const raw = await chat(settings, prompt, signal)
  const arr = extractJson<AiChild[]>(raw)
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 未返回有效的主干节点')
  return arr
}

/** 模式A：标准化知识下探（把该主题「讲透」的分层讲义） */
export async function expandStandard(
  settings: Settings,
  profile: LearningProfile,
  path: string[],
  nodeTitle: string,
  nodeContent: string,
  prefs: Prefs,
  signal?: AbortSignal,
): Promise<AiChild[]> {
  const prompt = `学习档案：领域「${profile.domain}」｜学习者：${profile.learner}｜学习目标：${profile.goal}｜视角：${profile.perspective}
知识路径：${path.join(' → ')}
当前要讲透的主题：「${nodeTitle}」${nodeContent ? `（已有概括：${nodeContent}）` : ''}
${styleBlock(prefs)}
请把「讲透这个主题」的回答分层展开为 4~8 个下级节点：
- 子节点顺序即讲解顺序，按主题实际情况选择层次（例如：直觉与动机 → 核心机制 → 用法与场景 → 易错点），不机械套模板
- 讲解始终服务于学习目标与视角，不为全面而全面
- 每个子节点的 content 像讲义的一小节：自然讲解 1~4 句，长短随内容需要，并与父主题、前后兄弟节点自然衔接
- 子节点之间不重复，合起来完整覆盖该主题的关键层面
输出 JSON 数组：
[{"title": "...", "content": "..."}]`
  const raw = await chat(settings, prompt, signal)
  const arr = extractJson<AiChild[]>(raw)
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI 未返回有效的子节点')
  return arr
}

/** 模式B：个性化疑问下探（导师式回答学生追问） */
export async function expandQuestion(
  settings: Settings,
  profile: LearningProfile,
  path: string[],
  nodeTitle: string,
  question: string,
  prefs: Prefs,
  signal?: AbortSignal,
): Promise<{ answer: string; children: AiChild[] }> {
  const prompt = `学习档案：领域「${profile.domain}」｜学习者：${profile.learner}｜学习目标：${profile.goal}｜视角：${profile.perspective}
知识路径：${path.join(' → ')}
所属节点：「${nodeTitle}」
学生的追问：「${question}」
${styleBlock(prefs)}
请像导师回答学生的追问：
- answer：先给直接的结论或直觉，再讲清原因与来龙去脉，自然成段（约 100~300 字，按需要伸缩），不要罗列干巴巴的要点
- children：理解这个回答所需的铺垫、或顺着该疑问值得继续追问的点（2~5 个，与疑问真正相关才要，不凑数），每个 content 用 1~3 句自然讲解
输出 JSON 对象：
{"answer": "...", "children": [{"title": "...", "content": "..."}]}`
  const raw = await chat(settings, prompt, signal)
  const obj = extractJson<{ answer: string; children?: AiChild[] }>(raw)
  return { answer: obj.answer ?? '', children: Array.isArray(obj.children) ? obj.children : [] }
}
