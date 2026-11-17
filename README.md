# 简阅笔记（JYD Note）

本地运行的 AI 笔记知识库：导入自己的笔记文件，后台自动解析、切分、建立向量索引；提问时先检索相关片段，再由大模型基于原文作答，并逐条标注引用来源。

- **三种模型来源**：默认使用 DeepSeek `deepseek-flash` 对话、阿里云百炼 `text-embedding-v4` 向量化；也可以切到 LM Studio 或任意 OpenAI 兼容 API，或完全本地的 Ollama。对话与嵌入可以任意混搭。
- **数据留在本机**：文档与索引保存在本机，对话仅在当前窗口内保留。云端模式只发送你的问题和检索到的片段，不会上传整份文档。
- **多格式 + 整目录导入**：TXT、Markdown、Word（.docx）、Excel（.xlsx/.xls/.csv）、PDF、PPT（.pptx）、图片；支持选择整个文件夹递归导入。
- **应用内新建 / 编辑笔记**：直接写 Markdown 或 TXT 笔记，选择保存目录；已有的 TXT / Markdown 文档也能在应用内修改。只改写知识库内的副本，磁盘上的原始文件不会被改动。
- **目录管理**：导入的目录层级会保留在左侧；也可以手动新建、重命名、删除目录，把文档移动到指定目录，或直接拖拽归类。文档列表支持全选与多选后批量移动。所有文档仍在同一个知识库中一起检索。
- **原位预览**：Word 排版与表格、Excel 工作表、PDF 原页、PPT 幻灯片都能在应用内直接查看，不必另开原文件。
- **浅色 / 深色主题**：设置里一键切换，保存后下次启动沿用，原生标题栏也会跟随。
- **可选重排序**：开启后由阿里云百炼 `qwen3-rerank` 对混合检索候选重新打分，提高引用命中率；失败时自动退回原顺序。
- **可回溯**：每个回答附引用卡片，点击即可查看被引用的原文。
- **零原生依赖**：知识库用普通文件存储，不需要 SQLite、FAISS 或编译工具链。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用手册](docs/使用手册.md) | 导入、索引状态、提问与引用、重建索引、数据迁移 |
| [配置与模型](docs/配置与模型.md) | 全部设置项、DeepSeek / 百炼 / LM Studio / Ollama、向量空间与安全说明 |
| [架构与开发](docs/架构与开发.md) | 进程边界、数据流、存储格式、检索实现、IPC、测试与扩展 |
| [故障排查](docs/故障排查.md) | 按错误信息定位云端、索引、检索、Ollama 与构建问题 |

## 界面与使用方式

1. 点击「新建笔记」直接写 Markdown / TXT 笔记；或点击「导入文件」「导入文件夹」选择已有资料，也可以把文件 / 文件夹直接拖进窗口。
2. 新建或导入后状态显示「解析索引中…」，完成后变为可点击的文档。
3. 在右下角状态按钮或「设置」里确认模型连接状态。
4. 在底部输入问题，回答会流式输出，下方列出引用来源。
5. 点击来源卡片查看预览：TXT / Markdown 展示库内原文，Markdown 可直接阅读排版或切换原文；Word、Excel、PDF、PPT、图片展示富预览（表格、工作表、原页、幻灯片）。也可以从文档详情里用系统程序打开原文件。

文件夹导入会递归扫描子目录，忽略隐藏文件和隐藏目录，最多 8 层、最多 5000 个文件；不支持的类型会被跳过。相对目录会保存在文档元数据中，左侧知识库按目录树分组，目录行可展开 / 收起。顶部「知识库」右侧的文件夹按钮可以新建目录，目录行悬停后可新建子目录、重命名或删除；文档行的移动按钮或拖拽可把文档归入目录。目录只是知识库内的分类，不会改动磁盘上的原始文件。当前是「一次性导入」，不是持续监听目录变化，新增文件需要再次导入。

支持的扩展名：`txt` `md` `markdown` `docx` `xlsx` `xls` `csv` `pdf` `pptx` `png` `jpg` `jpeg` `webp` `bmp` `tif` `tiff`。

## 工作原理

```
导入：复制原件（或应用内写入笔记副本）→ 解析为文本块 → 按语义/结构切块 → 向量化 → 写入本地索引
提问：问题向量化 → 向量召回 + BM25 关键词召回 → RRF 融合 → 按预算拼上下文 → 对话模型流式作答
```

关键设计：

| 环节 | 实现 | 说明 |
| --- | --- | --- |
| TXT / MD | 自定义解析器 | 自动识别 UTF-8 / UTF-16 / GBK / GB18030；Markdown 按标题建层级，代码块中的 `#` 不误判 |
| Word | mammoth → HTML → turndown | 转为 Markdown 后复用标题结构；表格单元格先压平，再转成 Markdown 表格 |
| Excel / CSV | SheetJS | 每个工作表转 Markdown 表格，每 12 行重复一次表头，片段单独被检索时也知道字段名 |
| PDF | unpdf | 按页提取文字并保留页码；纯扫描件会给出明确提示 |
| PPT | JSZip + xmldom | 读取 OOXML 幻灯片，提取文本框、表格、备注与标题层级，同时保留版式坐标供预览 |
| 图片 | Ollama 视觉模型，或 tesseract.js OCR | 配置了视觉模型就优先使用；否则走完全离线的本地 OCR |
| 切块 | 按句末标点、标题、页码、工作表切分 | 默认 900 字符 / 120 字符重叠，尾部过短的块会合并 |
| 向量（云端） | 百炼 `text-embedding-v4` | OpenAI 兼容接口，单批最多 10 条自动分批，默认 1024 维，可改 64–2048 维 |
| 向量（兼容 API） | LM Studio 或任意 OpenAI 兼容 `/embeddings` | 每批 10 条，维度由返回结果推断，适配本地与云端兼容服务 |
| 向量（本地） | Ollama `bge-m3` | L2 归一化，Float32 存储；余弦相似度退化为点积 |
| 关键词 | 中文单字 + 二元组 + 拉丁词 BM25 | 解决短查询、专有名词、模型未收录词的召回 |
| 融合 | RRF（k=60），单文档最多 4 条 | 向量与关键词互补，避免同一篇笔记淹没答案 |
| 回答（云端） | DeepSeek `deepseek-flash` | OpenAI 兼容 SSE 流式接口；请求中关闭思考模式，只展示正式回答 |
| 回答（兼容 API） | LM Studio 或任意 OpenAI 兼容 `/chat/completions` | SSE 流式；API Key 可选，LM Studio 默认不鉴权 |
| 回答（本地） | Ollama `/api/chat` | 严格约束的系统提示词，只允许依据资料作答 |

为什么向量检索用暴力扫描：个人笔记通常在数万片段以内，一次点积扫描只需几十毫秒；这样避免引入原生扩展，也便于直接拷贝数据目录。索引规模继续增长时可以替换为 HNSW 或 `sqlite-vec`，检索接口已经隔离在 `KnowledgeBase.hybridSearch`。

## 快速开始

### 1. 安装依赖

需要 Node.js 20+（开发时使用 Node 24）。

```bash
npm install
```

如果安装后 `node_modules/electron/dist/electron.exe` 不存在（npm 11 的 install-scripts 拦截），手动补装 Electron 二进制：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

PowerShell：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
```

### 2. 配置云端模型（默认模式）

在 DeepSeek 与阿里云百炼控制台分别创建 API Key，启动应用后打开「设置」：

- **对话模型**：选择「DeepSeek 云端」，填入 DeepSeek API Key。Base URL 默认 `https://api.deepseek.com`，模型默认 `deepseek-flash`。
- **嵌入模型**：选择「阿里云百炼」，填入百炼 API Key。Base URL 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型默认 `text-embedding-v4`，向量维度默认 1024。
- 点击「测试连接」，会分别显示对话模型和嵌入模型是否就绪，成功后可看到可用模型标签，直接点选即可切换。

API Key 也可以不写进界面，改为在启动应用前设置环境变量（设置里的输入框留空时生效）：

```bash
DEEPSEEK_API_KEY=sk-...       # Windows PowerShell: $env:DEEPSEEK_API_KEY="sk-..."
DASHSCOPE_API_KEY=sk-...
```

> **安全提醒**：API Key 以明文保存在本机 `%APPDATA%\JydNote\settings.json`，请确保系统账户与磁盘安全；建议为这个应用单独创建 Key、限制额度，并在泄露或共用电脑时及时轮换。应用不会把 Key 写进日志，也不会发送给所配置服务商之外的第三方。

### 3. 运行

```bash
npm run dev        # 开发模式（热更新）
npm run build      # 只构建到 out/
npm start          # 预览已构建产物
npm run package    # 打包 Windows NSIS 安装包到 release/
```

首次运行打开「设置」→「测试连接」，确认对话与嵌入两侧都显示成功，再导入笔记。嵌入模型未配置时无法导入（因为需要生成向量）。

## 完全本地模式（可选）

不需要任何联网模型服务时，把「对话模型」与「嵌入模型」都切到「本地 Ollama」，原有本地链路会完整保留。

从 [ollama.com](https://ollama.com) 安装后，确认服务运行：

```bash
ollama --version
curl http://127.0.0.1:11434/api/tags
```

拉取默认模型：

```bash
ollama pull qwen3:4b      # 对话模型，约 2.5GB
ollama pull bge-m3        # 嵌入模型，中文效果好，约 1.2GB
# 可选：图片理解
ollama pull qwen2.5vl:3b
```

在设置里切换后，对话模型默认变为 `qwen3:4b`，嵌入模型默认变为 `bge-m3`。显存更充裕时可以换成 `qwen2.5:7b`、`qwen3:8b`；显存紧张时可用 `qwen2.5:3b`。嵌入模型也可以换成更小的 `nomic-embed-text`，但更换后必须重建索引。

> **切换嵌入模型 / 提供方 / 向量维度后，旧向量与新向量不在同一个空间**，检索会跳过不匹配的文档，侧边栏会出现「重建」提示。重建期间原有文档仍可检索。

### 离线 OCR 语言数据（可选，图片走 OCR 时需要）

```bash
npm run fetch-ocr
```

脚本优先从 `@tesseract.js-data/*` 依赖包复制 `chi_sim` / `eng` 语言数据到 `resources/tessdata`，不重复联网；数据包缺失时才尝试 jsDelivr / GitHub 镜像。也可以手动下载 `chi_sim.traineddata.gz`、`eng.traineddata.gz`（[tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)）放进该目录。

OCR 链路可单独验证：

```bash
npm run check-ocr
```

## LM Studio 与 OpenAI 兼容服务（可选）

LM Studio 可以在本机加载对话和嵌入模型，并暴露 OpenAI 兼容接口，适合不想安装 Ollama、又需要完全离线运行的场景。

1. 在 LM Studio 中分别加载一个对话模型（如 Qwen3 8B）和一个嵌入模型（如 bge-m3）。
2. 打开 Local Server，确认监听 `http://127.0.0.1:1234`。
3. 在「设置」里把对话或嵌入提供方切到「LM Studio / API」，服务地址填 `http://127.0.0.1:1234/v1`，API Key 留空。
4. 点击「测试连接」，从返回的模型列表中点选已加载的模型；对话和嵌入分别选择各自的模型。

也可以把地址换成任意 OpenAI 兼容服务（自建网关、其他云厂商），此时按需填写 API Key，应用会以 `Authorization: Bearer` 发送。

- 嵌入维度由服务返回结果自动识别，不需要手动填写。
- 更换嵌入服务地址或模型后，旧向量空间不一致，需要重建索引。
- 对话与嵌入共用同一个兼容服务地址和 Key；LM Studio 可以在同一服务里同时加载两类模型。

## 离线部署

只有对话与嵌入都切到「本地 Ollama」，或都指向本机 LM Studio / 自建 OpenAI 兼容网关时才能完全离线。默认的 DeepSeek / 百炼模式需要外网。

目标机器不需要互联网的部署方式：

1. **应用安装包**：在有网机器上执行 `npm install && npm run fetch-ocr && npm run package`，把 `release/` 中的安装包拷过去。
2. **本地模型服务**：安装 Ollama（官方 Windows 安装程序），或安装 LM Studio 并启动本地服务；两者任选其一即可。
3. **模型文件**：在有网机器拉取 / 下载模型后，复制整个 `%USERPROFILE%\.ollama\models` 目录（Ollama）或 LM Studio 的模型目录到离线机器的相同位置。
4. **OCR 语言数据**：已经包含在安装包的 `resources/tessdata` 中，无需额外操作。

装好后启动应用，在设置里把两个提供方都切到「本地 Ollama」或都切到「LM Studio / API」；全程没有外部网络请求。迁移知识库时复制 `%APPDATA%\JydNote` 即可。

## 数据存放位置

Windows 下统一在 `%APPDATA%\JydNote\`：

```
%APPDATA%\JydNote\
├─ settings.json          应用设置（含 API Key，明文）
├─ library\
│  ├─ index.json          文档元数据（名称、状态、片段数、嵌入提供方、模型、维度…）
│  └─ docs\<id>\
│     ├─ source.docx      导入时复制的原件（应用内新建 / 编辑的笔记同样写在这里）
│     ├─ doc.json         片段文本与标题路径 / 页码 / 工作表
│     └─ vectors.bin      归一化 Float32 向量（行优先，chunk 数 × 维度）
└─ ocr-cache\             tesseract 缓存
```

- 删除知识库条目只会删 `library` 内的副本，不影响原始文件。
- 索引状态在启动时从 `index.json` 恢复；如果上次在索引中途退出，该文档会被标记为「上次索引未完成」，点击重试即可。
- 每条文档记录了 `embedProvider` 与 `embedModel`；只有提供方和模型都匹配的向量才会参与检索。旧版本索引没有 `embedProvider`，按本地 Ollama 处理。

## 项目结构

```
src/
├─ shared/types.ts            主进程 / 渲染进程共享的类型、默认设置与 IPC 契约
├─ shared/notes.ts            笔记标题 / 正文校验与文件名规则（三端共用）
├─ main/
│  ├─ index.ts                窗口、单实例、生命周期
│  ├─ ipc.ts                  全部 IPC 通道与流式事件
│  ├─ paths.ts                userData / settings / tessdata 路径
│  ├─ settings.ts             设置读写、迁移与数值约束
│  ├─ services/library.ts     导入队列、解析、嵌入、重建索引（含文件夹递归扫描）
│  └─ core/
│     ├─ decode.ts            编码探测与文本清洗
│     ├─ tokenize.ts          中文单字 + 二元组分词（BM25 用）
│     ├─ chunker.ts           结构化切块与重叠
│     ├─ cloud.ts             DeepSeek / 百炼 / OpenAI 兼容客户端与错误翻译
│     ├─ models.ts            按设置分发到云端或 Ollama，并汇总模型状态
│     ├─ ollama.ts            /api/embed、/api/chat 流、视觉模型调用
│     ├─ rag.ts               检索 → 上下文预算 → 引用式提示词
│     ├─ kb.ts                元数据、向量文件、BM25、RRF 与目录树
│     ├─ preview.ts           Word / Excel / PDF / PPT 预览数据
│     └─ parsers/             txt/md、docx、sheet、pdf、pptx、image
├─ preload/index.ts           contextBridge 暴露 window.jyd
└─ renderer/src/
   ├─ App.tsx                 状态编排与事件订阅
   ├─ styles.css              全部界面样式
   └─ components/             侧边栏、文档列表、聊天、引用、设置、预览等组件
scripts/
├─ smoke.ts                   解析 / 切块 / 检索 / 云端客户端冒烟测试
├─ ocr-check.ts               OCR 链路检查
└─ fetch-ocr-data.mjs         OCR 语言数据准备
docs/
├─ 使用手册.md                面向使用者的完整操作流程
├─ 配置与模型.md              全部配置项、提供方与向量空间说明
├─ 架构与开发.md              架构、存储、检索、IPC、测试与扩展
└─ 故障排查.md                按错误信息定位问题
resources/tessdata/           离线 OCR 数据（构建时随包复制）
```

界面按组件拆分：`Sidebar`、`DocList`、`StatusPill`、`ChatPanel`、`ChatMessageView`、`SourceList`、`SettingsDialog`、`SegmentedControl`、`SecretField`、`DocViewer`、`DocPreview`、`FolderNameDialog`、`MoveDocDialog`、`FolderPicker`、`NoteEditorDialog` 等，样式与交互都收在组件内；`App.tsx` 只做状态与事件编排。

## 验证

```bash
npm run typecheck   # 主进程 + 渲染进程类型检查
npm run smoke       # 17 项核心链路检查，不依赖真实模型服务
npm run check-ocr   # tesseract worker + 本地语言数据
npm run build       # electron-vite 生产构建
```

`npm run smoke` 覆盖：GBK / UTF-8 BOM 解码、中文分词、笔记标题 / 正文校验、Markdown 标题层级、长文切块边界、Excel 表头重复、docx 解析、PDF 按页提取、知识库保存/向量检索/BM25/重载、目录创建/重命名/移动/删除与持久化、删除后不再召回、崩溃后索引状态恢复。云端与兼容服务部分使用本地 mock HTTP 服务验证：DeepSeek SSE 流式拼接（忽略 `reasoning_content`、关闭思考模式）、百炼每批最多 10 条的自动分批、乱序响应还原、鉴权头与模型状态汇总；LM Studio / OpenAI 兼容服务的模型探测、可选鉴权、无 `thinking` 参数、向量分批与维度推断；不会消耗真实额度。

## 常见问题

**DeepSeek 提示 API Key 无效**：检查 Key 是否复制完整、是否属于当前 Base URL 对应的服务；余额不足（402）和限流（429）会给出不同提示。

**百炼提示维度或参数错误**：确认向量维度是该模型支持的取值（2048/1536/1024/768/512/256/128/64）；`text-embedding-v4` 单条输入上限 8192 tokens，超长片段需要减小分块大小。

**LM Studio / OpenAI 兼容服务连接失败**：确认 LM Studio 的 Local Server 已启动、模型已加载，服务地址包含 `/v1`（默认 `http://127.0.0.1:1234/v1`）；调用云端兼容 API 时才需要填写 Key。代理环境同样把 `127.0.0.1` 加入 `NO_PROXY`。

**Ollama 未连接**：确认 `ollama serve` 或桌面端正在运行，地址默认为 `http://127.0.0.1:11434`；公司代理环境请把 `127.0.0.1` 加入 `NO_PROXY`。

**缺少模型**：状态提示里会写明缺少哪个模型，执行 `ollama pull <模型名>`。设置里「测试连接」成功后出现的模型标签可以直接点选。

**PDF 提示没有可提取文字**：这是扫描件。可以把页面截图作为图片导入（配置视觉模型或 OCR），或先用 OCR 工具生成可搜索 PDF。

**图片导入失败**：优先在设置里填写视觉模型名（如 `qwen2.5vl:3b`）；使用 OCR 时确认 `resources/tessdata` 内有 `chi_sim.traineddata.gz` 和 `eng.traineddata.gz`，可运行 `npm run fetch-ocr`。

**回答总是说「笔记中没有找到相关内容」**：先确认文档状态为就绪；问题尽量包含笔记中的关键词；BM25 与向量是互补的，换个更具体的说法通常有效。

**更换嵌入模型或向量维度后旧文档检索不到**：不同模型 / 维度的向量空间不通用。点击侧边栏「重建」，或逐篇重试索引。

**显存不足 / 速度慢（本地模式）**：换更小的模型，或降低「引用片段数」与「上下文字符上限」。Ollama 会自动把放不下的层放到 CPU，速度会下降但不会崩。

## 已知限制

- 云端模式需要联网，问题和命中的笔记片段会发送给所选服务商；不发送未命中的文档。
- 扫描版 PDF 不会自动渲染页面做 OCR（避免引入 PDF 渲染依赖）；图片可以走 OCR / 视觉模型。
- 图片只提取文字或描述，不保留版面坐标；Excel 只索引单元格文本值，不保留公式和样式。
- 暂不支持 `.doc`、`.ppt`、加密文档；`.pptx` 预览只还原解析出的文字、图片与表格，动画和主题字体可能与 PowerPoint 有差异。
- 对话为单轮检索问答，不携带历史上下文；每次提问都重新检索。
- 对话只保留在当前窗口内，关闭应用后清空。
- 文件夹为一次性导入，不监听后续变化；同一文件重复导入不会自动去重。
- 知识库文件未加密；API Key 在设置文件中也是明文，敏感数据请自行使用磁盘加密。

## 可扩展方向

- 接入手写或版面 OCR（PaddleOCR / 视觉模型 + 坐标回填）。
- 用 HNSW、`sqlite-vec` 或 LanceDB 替换暴力向量扫描。
- 增加多轮对话的查询改写与上下文压缩。
- 增加标签、按目录过滤以及按文档/时间范围检索。
- 引用定位到原文段落并高亮。

## License

MIT
