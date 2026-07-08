# `@leapunion/agentic-runtrace` — 抽取 MANIFEST(Phase B · ADR-0004)

> 本包 = `agentic-runtrace-chatbot` skill 的**版本化沉淀**(A→B step 1)。此表定义:哪些 skill 模板**搬进包**(通用核心 · 版本化),哪些**留项目**(brand-specific · Adapter/route/key)。搬迁在 **B-2** 执行;本骨架先锁**边界 + 公共 API 契约**。

## 1. 搬进包(通用核心 · 零品牌值 · semver)

| skill 模板 | → 包路径 | 导出子路径 | 侧 |
|---|---|---|---|
| `templates/agentic-chain-data.ts` | `src/types/chain-data.ts` | `.`(types)| 同构(client+server 共享)|
| `templates/reasoning-action-chain.tsx` | `src/components/reasoning-action-chain.tsx` | `.` | **client** `"use client"` |
| `templates/agentic-run-trace.tsx` | `src/components/agentic-run-trace.tsx` | `.` | **client** |
| `templates/agentic-chatbot.tsx` | `src/components/agentic-chatbot.tsx` | `.` | **client** |
| `templates/use-agentic-run.ts` | `src/hooks/use-agentic-run.ts` | `.` | **client** hook |
| `templates/agentic-orchestrator.ts` | `src/engine/orchestrator.ts` | `./engine` | **server**(fs/path · Node)|
| `templates/agentic-adapter.ts` | `src/engine/adapter.ts` | `./engine` | server(接口 + `createLocalSnapshotAdapter` 工厂)|
| `templates/chat-store.ts` | `src/chat-store/index.ts` | `./chat-store` | client(localStorage · 可注入 server 持久化)|

> **子路径拆分理由**:`.` = client UI(不含 Node fs);`./engine` = server 编排(项目 route 里 import);`./chat-store` = 持久化。项目 client bundle 永不因引擎拉进 Node 内建。

## 2. 留项目(brand-specific · 薄 Adapter/route · §11/§0/§12)

| 项 | 归属 | 说明 |
|---|---|---|
| **Adapter 实现**(matchTools / loadRows / summarize / chart / detectConnector / memory? / llm)| 项目 `lib/agentic/project-adapter.ts` | 品牌意图 + 数据源 + gateway key(§0 env)· 用包的 `createLocalSnapshotAdapter` 或裸实现 `AgenticAdapter` |
| **API route**(`app/api/agentic-run/route.ts`)| 项目 | `import { runAgentic } from "@leapunion/agentic-runtrace/engine"` + 注入项目 adapter → NDJSON 流 |
| **gateway key / snapshots / DB** | 项目 env / 数据 | 数据本地 · Token=0 · 不进包 |
| **chartRenderer / markdownRenderer**(可选)| 项目传 prop | 项目自家 ECharts/SmartChart |
| **页面挂载 + chat 侧栏** | 项目 | `<AgenticChatbot user config chartRenderer/>` |

> rolife 特例:`lib/ops-command/swarm-bridge.ts`(8 commerce 引擎)= rolife 的 Adapter 的一部分,**留 rolife**;不进通用包(§11)。

## 3. 公共 API 契约(锁定 · semver)

**`@leapunion/agentic-runtrace`(client UI + types)**
```
AgenticChatbot, AgenticRunTrace, ReasoningActionChain, CoordBadge   // components
useAgenticRun                                                        // hook
type AgenticRun, ChainStep, ChainChild, ChainSource, Coord, StepKind,
     ConnectorAuth, ChartData, DataSource, DataMode,
     PlannerInfo, MemoryInfo, RunError, RunMetrics, AgenticUIConfig  // types
COORD_LEGEND                                                         // const
```
**`@leapunion/agentic-runtrace/engine`(server)**
```
runAgentic(input, adapter): AsyncGenerator<WireEvent>
createLocalSnapshotAdapter(opts): AgenticAdapter
type AgenticAdapter, ToolMatch, AdapterLLM, WireEvent, AgenticInput
```
**`@leapunion/agentic-runtrace/chat-store`(persistence)**
```
createChat, getChat, getChats, appendTurn, renameChat, deleteChat,
useChats, useActiveChatId, setActiveChatId, useCurrentUser, configureChatStore
type ChatSession, ChatMessage
```

## 4. semver 纪律
- WireEvent / ChainStep / AgenticRun **加可选字段** = **minor**(向后兼容 · 消费者忽略新字段)。
- 改/删字段、改组件 prop 结构、改 `.`/`./engine` 边界 = **major** + CHANGELOG + migration note。
- 每次 skill 拉齐(如 `references/05` 5 模块)→ 包 minor bump → 全项目 `npm update` 回流(**这就是治 drift 的机制**)。

## 5. 下一步(B-2 执行清单)
1. `git mv` skill `templates/*` → 包 `src/*`(按 §1 表)· 加 `"use client"`(client 文件)· 相对 import 修正。
2. 剥离 `agentic-run-route.ts`(它属项目 route · 不进包)· `example-adapter.ts` → 包 `examples/`(非发布)。
3. `npm run build`(tsup)+ `typecheck` + `lint:debrand` 绿。
4. 发布 0.1.0(GitHub Packages / 或 git-dependency)。
5. rolife 换依赖(RFC-0002 B-2)· 删 in-app copy · preview → prod。
