# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

简阅笔记（JYD Note）是一个 Electron 桌面知识库：导入笔记文件，本地解析、切块、向量化并建立文件索引；提问时先做向量 + BM25 混合检索，再把片段交给对话模型生成带引用的流式回答。

- 默认云端模式：DeepSeek `deepseek-flash` + 阿里云百炼 `text-embedding-v4`。
- 可选 `openai` 提供方：LM Studio 或任意 OpenAI 兼容 API，API Key 可选；对话与嵌入共用一个 `openaiBaseUrl`。
- 可选完全本地模式：对话和嵌入都切到 Ollama。
- 详细设计见 `docs/架构与开发.md`；配置项见 `docs/配置与模型.md`。

## Commands

```bash
npm install              # Node.js 20+
npm run dev              # electron-vite 开发模式
npm run typecheck        # 分别检查主进程和渲染进程（tsconfig.node / tsconfig.web）
npm run smoke            # 全部冒烟测试（plain assert，无测试框架）
npm run check-ocr        # tesseract worker + 本地语言数据
npm run build            # 生产构建到 out/
npm start                # 预览构建产物
npm run fetch-ocr        # 准备 resources/tessdata 语言数据
npm run package          # 构建并打包 Windows NSIS 到 release/
```

- 没有 lint 脚本。提交前至少跑 `npm run typecheck`；涉及核心链路时再跑 `npm run smoke && npm run build`。
- `scripts/smoke.ts` 没有 `--filter` 或单测运行器，15 项检查按顺序执行。需要单测某一项时，用 `tsx` 单独执行对应函数/片段，或临时注释其余 `run(...)` 调用。
- npm 11 可能跳过 Electron 的 postinstall。若 `node_modules/electron/dist/electron.exe` 不存在：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

## Architecture

### Process model

- `src/main/` 是 CommonJS 主进程，负责文件、解析、嵌入、网络请求和设置持久化。
- `src/preload/index.ts` 通过 contextBridge 暴露唯一的 `window.jyd` API；`contextIsolation: true`、`nodeIntegration: false`。
- `src/renderer/` 是 React，不能直接读文件或访问模型。新增能力必须走 `shared/types.ts` 的契约 → `ipc.ts` → `preload/index.ts` → 渲染进程。
- 用户可见的错误信息使用中文，并给出可执行的下一步。

### Import pipeline

`LibraryService`（`src/main/services/library.ts`）用 Promise 链串行化导入与重建：

```text
文件/目录 → collectFiles → parseDocument → chunkBlocks → embedTexts → KnowledgeBase.saveDoc
```

- 目录递归：忽略隐藏项，深度 ≤ 8，最多 5000 个文件；一次性导入，不监听变化。
- 文件夹导入会写入 `DocMeta.folder`（相对所选文件夹的路径，`/` 分隔，含所选文件夹名），并把目录登记到 `folders.json`；左侧 `DocList` 结合两者构建可折叠目录树，目录默认折叠，手动创建的空目录也能保留。单文件导入和旧索引没有该字段，显示在根级。
- 目录是库内虚拟分类：`KnowledgeBase` 负责创建/重命名/删除目录和移动文档，不改动磁盘原文件。重命名要同步子目录与文档的 `folder` 前缀；删除目录时内容上移到父目录。
- 应用内新建 / 编辑笔记复用同一流水线：`createNote` / `updateNote` 在队列内以 UTF-8 原子写入 `docs/<id>/source.md|txt`（`writeFileAtomic`），随后 `indexStoredSource` 后台调用 `importOne`；IPC 不等待嵌入完成。编辑只改库内副本，绝不碰外部原文件；只有 `text` / `markdown` 可编辑，标题与正文校验在 `src/shared/notes.ts`（主进程、渲染进程、smoke 共用）。
- `importPaths` / `removeDoc` / `reindexDoc` / `reindexAll` / 笔记写入 / 后台索引都走 `enqueue()` 串行队列。`importOne` 在 `saveDoc` 与错误写回前重新读取最新 `DocMeta`：已删除则放弃提交，已移动则沿用最新 `folder`，防止幽灵文档或覆盖目录归类。
- 进度通过 `import:progress` 广播；文档列表刷新通过 `library:changed`。
- 应用中断后，启动时把残留的 `indexing` / `pending` 标为 `error`，等待用户重试。
- 解析器在 `src/main/core/parsers/`，每个解析器只产出 `TextBlock[]`，切块、向量化、检索自动复用。新增格式需同时更新 `parsers/index.ts` 的注册表、`DocKind` 和 UI 标签。

### Query pipeline

`src/main/core/rag.ts`：

```text
question → embedTexts → KnowledgeBase.hybridSearch →（可选 qwen3-rerank）→ 上下文预算 → chatStream
```

- 向量召回与 BM25 召回各取 `max(20, topK × 3)`，用 RRF（k=60）融合；单文档最多 4 条。
- `rerankEnabled` 时向 `hybridSearch` 传更大的 `candidateLimit`（`max(16, topK × 2)`，最多 50），再用百炼 `qwen3-rerank` 重排；重排序失败必须退回原顺序并继续回答，不能阻断问答。
- 前 3 条片段即使超出 `maxContextChars` 也会保留，保证至少有资料可答。
- 检索为空时不调用对话模型，直接返回固定提示。
- 问答通过 `rag:stream` 推送 `sources` / `delta` / `done` / `error`；取消由 `rag:abort` 按 `requestId` 中止。

### Provider abstraction

`src/main/core/models.ts` 是唯一分发点：

- `cloud.ts`：DeepSeek `/chat/completions` SSE、百炼 `/embeddings`，以及通用的 OpenAI 兼容探测 / 对话 / 嵌入（`openaiProbe` / `openaiChatStream` / `openaiEmbed`）；负责批次、SSE 行缓冲、`reasoning_content` 忽略、维度校验、L2 归一化和中文错误翻译。
- `ollama.ts`：`/api/embed`（回退 `/api/embeddings`）、`/api/chat`、视觉模型 `/api/generate`。
- 对话和嵌入的提供方互相独立，允许云端 + 本地混搭。
- 「测试连接」分别探测 `/models`（DeepSeek）、一次最小嵌入请求（百炼）、`GET /models`（OpenAI 兼容，Key 可选）、`/api/tags` + `/api/version`（Ollama），返回 `chatReady` / `embedReady` 两套状态与 `chatModels` / `embedModels` 列表。

### Storage and vector-space invariant

`KnowledgeBase`（`src/main/core/kb.ts`）使用普通文件：

```text
%APPDATA%\JydNote\library\index.json          DocMeta[]
%APPDATA%\JydNote\library\folders.json        目录路径 string[]
%APPDATA%\JydNote\library\docs\<id>\source.*  原件副本
%APPDATA%\JydNote\library\docs\<id>\doc.json  { chunks: ChunkMeta[] }
%APPDATA%\JydNote\library\docs\<id>\vectors.bin 归一化 Float32，行优先，chunkCount × dim
```

- 每条文档记录 `embedProvider`、`embedModel`、`dim`。向量检索只使用三者全部匹配的文档；旧索引缺 `embedProvider` 时按 `ollama` 处理。
- 切换嵌入提供方、模型或百炼维度后必须重建索引。`App.tsx` 的 `needsReindex` 与保存后的提示都在检查这三项，新增设置或 provider 时要同步维护。
- 向量检索是暴力点积；BM25 使用中文单字 + 二元组 + 拉丁词。索引规模增大时替换点积实现，保持 `hybridSearch` 签名与向量空间过滤语义。
- 设置保存在 `%APPDATA%\JydNote\settings.json`。`settings.ts` 负责默认值、枚举/数值归一化和旧版本 Ollama 配置迁移。API Key 只持久化在设置文件，或通过 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` 环境变量提供；`openaiApiKey` 只来自设置文件且可为空；云端测试使用本地 mock 服务。

### Renderer conventions

- 组件放在 `src/renderer/src/components/`；`App.tsx` 只做状态与事件编排。
- `DocViewer` 预览 TXT / Markdown 时使用库内原文（`Markdown` 组件渲染并可切换原文），不要用切块拼接结果——重叠内容和〔标题〕标记会让正文重复。Word / Excel / PDF / PPT / 图片走 `DocContent.preview` 与 `DocPreview` 组件族。
- 文档列表的目录交互（新建/重命名弹窗、移动弹窗、拖拽）收在 `FolderNameDialog`、`MoveDocDialog` 与 `DocList`；拖拽使用 HTML5 事件和 `application/x-jyd-doc` 自定义 MIME。目录树默认折叠，只记录用户展开的路径。
- 目标目录选择统一用 `FolderPicker`（`MoveDocDialog` 与新建笔记共用），不要在各弹窗内重复实现列表。
- 新建 / 编辑笔记统一走 `NoteEditorDialog`：正文是非受控 `textarea`（大文本避免逐键重渲染），`Ctrl/Cmd+S` 保存，关闭时脏检查确认；入口是 `Sidebar` 的「新建笔记」和 `DocViewer` 页脚的「编辑」（`App.tsx` 用 `noteEditor` 状态编排，编辑弹窗打开时不渲染 `DocViewer`）。
- UI 能力优先抽成可复用组件（选择器、密钥输入、弹窗控件等），不要在页面里内联同类交互。现有通用组件：`SegmentedControl`、`SecretField`、`StatusPill`、`SourceList`、`ModelTags`（模型标签）、`OpenAiCompatibleFields`（兼容服务地址 / 可选 Key）与 `ThemePicker`（浅色 / 深色）等。
- 样式集中在 `src/renderer/src/styles.css`，按组件类名组织，与现有风格保持一致。颜色一律使用 `:root` 语义变量，深色值写在 `:root[data-theme='dark']` 覆盖块；组件里不要写死浅色。主题持久化在 `AppSettings.theme`，`lib/theme.ts` 负责 `html[data-theme]` 与首屏缓存，主进程同步 `nativeTheme.themeSource`。

## Non-obvious constraints

- 主进程是 CJS，而 `unpdf` 是 ESM-only，必须保持运行时动态 `import()`。
- PDF / 图片预览通过主进程注册的特权协议 `jyd-file://` 读取库内副本，只允许访问知识库根目录；不要改成 `file://`。
- PPT 预览基于 OOXML（JSZip + @xmldom/xmldom，EMU 坐标），字号需乘 `a:normAutofit@fontScale`；Word 表格转 Markdown 前要把单元格 `<p>` 压平并保证首行为表头。
- 百炼单批最多 10 条，单条上限约 8192 tokens，维度只能是 2048/1536/1024/768/512/256/128/64；响应必须按 `index` 还原顺序。
- `qwen3-rerank` 走 `{根地址}/compatible-api/v1/reranks`（注意不是 `compatible-mode`，且是复数 `reranks`），请求体是扁平的 `model/query/documents/top_n/return_documents`，响应读顶层 `results`；404/405 时回退原生 `/api/v1/services/rerank/text-rerank/text-rerank`（嵌套 `input` / `output.results`）。`index` 是候选数组的 0 基下标，`relevance_score` 只在单次请求内可比。
- DeepSeek 请求带 `thinking: { type: 'disabled' }`；只拼接 `delta.content`，不要展示 `reasoning_content`。通用 OpenAI 兼容分支绝不能发送 `thinking`，也不能发送 `dimensions`（LM Studio 等可能不支持），维度取响应向量长度。
- `openai` 提供方的 Base URL 默认带 `/v1`（`http://127.0.0.1:1234/v1`），调用时按 `{base}/models|chat/completions|embeddings` 拼接；Key 为空时不要添加 `Authorization`。
- `scripts/` 下有独立的 `package.json`（`"type": "module"`），使 `tsx` 脚本按 ESM 运行；不要把类型标成 CommonJS。
- 打包配置依赖 `extraResources` 复制 `resources/tessdata`，并把 `tesseract.js` / `tesseract.js-core` 加入 `asarUnpack`，否则打包后 OCR 会失败。
- 前端文档和用户文案使用中文；提交信息沿用中文 `type(scope): 摘要`，正文说明「为什么改」。
