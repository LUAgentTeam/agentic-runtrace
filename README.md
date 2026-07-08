# `@leapunion/agentic-runtrace`

> Versioned, brand-agnostic **Agentic 思维链·行动链 Run Trace ChatBot** — UI 组件 + in-process 引擎核心。
> **唯一项目代码 = 一个薄 Adapter**(tools/data);其余全在包里,`npm update` 升级、**drift 归零**。
>
> **状态:🟧 SKELETON(Phase B step 1 · [ADR-0004](../../docs/ADR/0004-agentic-runtrace-ui-distribution.md))。** 组件/引擎源码在 **B-2** 从 `agentic-runtrace-chatbot` skill 的 `templates/` 搬入(见 [`MANIFEST.md`](./MANIFEST.md))。本目录先锁**包配置 + 边界 + 公共 API 契约**。

## 为什么有这个包(A→B)

`agentic-runtrace-chatbot` skill 用 **scaffold-拷贝**分发模板 —— 物理上是 **fork**,导致 **drift**(skill 升级,项目 copy 跟不上,只能重 scaffold + 手动 merge)。本包把**通用核心版本化**:一处升级 → 全项目 `npm update` 回流。**引擎仍 in-process**(数据本地 · Token=0 · §0/§11),**不做微服务**(理由见 ADR-0004)。

- Skill(保留)= day-0 引导 + 方法论 + 治理(4-gate · 红线 · 事件协议)。
- 本包 = day-N 版本化升级。
- 二者**互补**,不重复。

## 安装(各品牌独立 repo → GitHub Packages)

```bash
# .npmrc(项目根 · §0:token 走 env,不入库)
@leapunion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```
```bash
npm install @leapunion/agentic-runtrace
```
> 更轻起点(pre-B2 免注册表):`npm i github:LUAgentTeam/agentic-runtrace#v0.1.0`(git-dependency · 见 RFC-0002 §8)。

## 用法(3 处 · 项目只写 Adapter)

**① Adapter(项目唯一专属代码 · brand-specific 全在这)**
```ts
import { createLocalSnapshotAdapter } from "@leapunion/agentic-runtrace/engine";
export const adapter = createLocalSnapshotAdapter({
  loadRows: (dataKey) => readSnapshot(dataKey),   // 项目数据源(本地 · Token=0)
  tools: [ /* { id, label, keywords, dataKey, summarize, chart? } */ ],
  connectors: [ /* 演示授权门 */ ],
  memory: (q, results) => ({ contextSummary, kbRefs, updates }), // 可选 · MemoryState
  llm: { configured: () => !!process.env.AI_GATEWAY_API_KEY, chat, fallbackModel }, // §0 env
});
```
**② API route(项目 · 注入 adapter)**
```ts
// app/api/agentic-run/route.ts
import { runAgentic } from "@leapunion/agentic-runtrace/engine";
import { adapter } from "@/lib/agentic/project-adapter";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const input = await req.json();
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      for await (const ev of runAgentic(input, adapter)) c.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}
```
**③ 页面挂载(client)**
```tsx
import { AgenticChatbot } from "@leapunion/agentic-runtrace";
<AgenticChatbot
  apiPath="/api/agentic-run"
  user={currentUser}
  config={{ showMemory: true, showMetrics: true, allowInterrupt: true, allowReplay: true }}
  chartRenderer={(c) => <SmartChart data={c} />}  // 项目自家图表
/>
```

## 公共 API(锁定 · semver)
见 [`MANIFEST.md` §3](./MANIFEST.md) —— `.`(UI+types)· `./engine`(runAgentic + adapter)· `./chat-store`(持久化)。

## semver 纪律
WireEvent/ChainStep **加可选字段 = minor**;改结构/prop = **major** + CHANGELOG。每次 skill 拉齐 → 包 minor bump → 全项目回流。

## 红线(继承 skill)
Token=0 默认 + LLM 经 Adapter opt-in(§0 key env)· **零品牌值**(brand 全走 Adapter · §11)· 连接器授权=演示门(§12)· light-first+`dark:` · reduced-motion + a11y。

## Related
[ADR-0004](../../docs/ADR/0004-agentic-runtrace-ui-distribution.md)(决策)· [MANIFEST](./MANIFEST.md)(搬迁映射)· skill `agentic-runtrace-chatbot`(引导 + 方法)· rolife `docs/RFC/0002`(首个消费者采纳)。
