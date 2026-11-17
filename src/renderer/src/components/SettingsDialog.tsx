import { useEffect, useState } from 'react'
import { Check, Loader2, Plug, X } from 'lucide-react'
import {
  DASHSCOPE_EMBED_DIMENSIONS,
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBED_MODELS,
  type AppSettings,
  type ChatProvider,
  type EmbedProvider,
  type ModelStatus,
  type ThemeMode
} from '../../../shared/types'
import SegmentedControl from './SegmentedControl'
import SecretField from './SecretField'
import ModelTags from './ModelTags'
import OpenAiCompatibleFields from './OpenAiCompatibleFields'
import ThemePicker from './ThemePicker'
import SwitchField from './SwitchField'

interface Props {
  initial: AppSettings
  status: ModelStatus | null
  onClose: () => void
  onSave: (settings: AppSettings) => Promise<void>
  onThemePreview: (theme: ThemeMode) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function SettingsDialog({
  initial,
  status,
  onClose,
  onSave,
  onThemePreview
}: Props) {
  const [form, setForm] = useState<AppSettings>(initial)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ModelStatus | null>(status)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  const changeChatProvider = (provider: ChatProvider): void => {
    setTestResult(null)
    setForm((previous) => ({
      ...previous,
      chatProvider: provider,
      chatModel:
        previous.chatProvider === provider
          ? previous.chatModel
          : DEFAULT_CHAT_MODELS[provider]
    }))
  }

  const changeEmbedProvider = (provider: EmbedProvider): void => {
    setTestResult(null)
    setForm((previous) => ({
      ...previous,
      embedProvider: provider,
      embedModel:
        previous.embedProvider === provider
          ? previous.embedModel
          : DEFAULT_EMBED_MODELS[provider]
    }))
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    try {
      setTestResult(await window.jyd.testModels(form))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setTesting(false)
    }
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSave(form)
    } catch (caught) {
      setError(messageOf(caught))
      setSaving(false)
    }
  }

  const checks = testResult
    ? [
        {
          key: 'chat',
          label: '对话模型',
          ready: testResult.chatReady,
          detail: testResult.chatDetail,
          error: testResult.chatError
        },
        {
          key: 'embed',
          label: '嵌入模型',
          ready: testResult.embedReady,
          detail: testResult.embedDetail,
          error: testResult.embedError
        },
        ...(testResult.rerankReady === undefined
          ? []
          : [
              {
                key: 'rerank',
                label: '重排序模型',
                ready: testResult.rerankReady,
                detail: testResult.rerankDetail,
                error: testResult.rerankError
              }
            ])
      ]
    : []

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog settings-dialog">
        <header className="dialog-header">
          <div>
            <h2>设置</h2>
            <p>配置只保存在本机；使用远程模型时仅发送检索到的片段</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

        <div className="dialog-body">
          <section className="settings-section">
            <h3>外观</h3>
            <p className="section-hint">切换后立即预览；保存设置后，下次启动也会沿用。</p>
            <ThemePicker
              value={form.theme}
              onChange={(theme) => {
                update('theme', theme)
                onThemePreview(theme)
              }}
            />
          </section>

          <section className="settings-section">
            <div className="section-heading">
              <h3>模型连接</h3>
              <button type="button" className="btn-outline" onClick={test} disabled={testing}>
                {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                测试连接
              </button>
            </div>
            <p className="section-hint">
              使用当前填写的配置测试，不需要先保存。API Key 只写入本机设置文件，不会上传。
            </p>
            {checks.length ? (
              <div className="status-checks">
                {checks.map((item) => (
                  <div
                    key={item.key}
                    className={`test-result ${item.ready ? 'ok' : 'bad'}`}
                  >
                    {item.ready ? <Check size={14} /> : <X size={14} />}
                    <span>
                      <strong>{item.label}：</strong>
                      {item.ready
                        ? item.detail ?? '已就绪'
                        : item.error ?? '未就绪，请检查上面的配置'}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <datalist id="available-models">
              {[
                ...new Set([...(testResult?.chatModels ?? []), ...(testResult?.embedModels ?? [])])
              ].map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </section>

          <section className="settings-section">
            <h3>对话模型</h3>
            <SegmentedControl<ChatProvider>
              value={form.chatProvider}
              label="对话模型提供方"
              options={[
                { value: 'deepseek', label: 'DeepSeek 云端' },
                { value: 'openai', label: 'LM Studio / API' },
                { value: 'ollama', label: '本地 Ollama' }
              ]}
              onChange={changeChatProvider}
            />

            {form.chatProvider === 'deepseek' ? (
              <>
                <p className="section-hint">
                  云端模式下，问题与检索到的笔记片段会发送到 DeepSeek。
                </p>
                <SecretField
                  label="DeepSeek API Key"
                  value={form.deepseekApiKey}
                  onChange={(value) => update('deepseekApiKey', value)}
                  placeholder="sk-..."
                  hint="留空则读取环境变量 DEEPSEEK_API_KEY"
                />
                <div className="field-grid">
                  <label>
                    <span>Base URL</span>
                    <input
                      value={form.deepseekBaseUrl}
                      onChange={(event) => update('deepseekBaseUrl', event.target.value)}
                      placeholder="https://api.deepseek.com"
                      spellCheck={false}
                    />
                    <small>官方地址，或兼容 OpenAI 协议的网关</small>
                  </label>
                  <label>
                    <span>对话模型</span>
                    <input
                      list="available-models"
                      value={form.chatModel}
                      onChange={(event) => update('chatModel', event.target.value)}
                      spellCheck={false}
                    />
                    <small>默认 deepseek-flash，思考模式已在请求中关闭</small>
                  </label>
                </div>
              </>
            ) : form.chatProvider === 'openai' ? (
              <>
                <p className="section-hint">
                  使用 LM Studio 本地部署或任意 OpenAI 兼容服务；填写模型名后，问题与检索片段会发送到该服务。
                </p>
                <OpenAiCompatibleFields
                  baseUrl={form.openaiBaseUrl}
                  apiKey={form.openaiApiKey}
                  onBaseUrlChange={(value) => update('openaiBaseUrl', value)}
                  onApiKeyChange={(value) => update('openaiApiKey', value)}
                />
                <div className="field-grid">
                  <label className="full">
                    <span>对话模型</span>
                    <input
                      list="available-models"
                      value={form.chatModel}
                      onChange={(event) => update('chatModel', event.target.value)}
                      placeholder="填写服务已加载的模型名"
                      spellCheck={false}
                    />
                    <small>测试连接后，可从下方模型列表点击填入</small>
                  </label>
                </div>
              </>
            ) : (
              <div className="field-grid">
                <label>
                  <span>对话模型</span>
                  <input
                    list="available-models"
                    value={form.chatModel}
                    onChange={(event) => update('chatModel', event.target.value)}
                    spellCheck={false}
                  />
                  <small>4GB 显存建议 qwen3:4b 或 qwen2.5:3b</small>
                </label>
                <label>
                  <span>Ollama 地址</span>
                  <input
                    value={form.ollamaUrl}
                    onChange={(event) => update('ollamaUrl', event.target.value)}
                    placeholder="http://127.0.0.1:11434"
                    spellCheck={false}
                  />
                  <small>本地模式的连接地址</small>
                </label>
              </div>
            )}
            <ModelTags
              models={testResult?.chatModels ?? []}
              label="可用对话模型（点击填入）"
              onPick={(model) => update('chatModel', model)}
            />
          </section>

          <section className="settings-section">
            <h3>嵌入模型</h3>
            <SegmentedControl<EmbedProvider>
              value={form.embedProvider}
              label="嵌入模型提供方"
              options={[
                { value: 'dashscope', label: '阿里云百炼' },
                { value: 'openai', label: 'LM Studio / API' },
                { value: 'ollama', label: '本地 Ollama' }
              ]}
              onChange={changeEmbedProvider}
            />

            {form.embedProvider === 'dashscope' ? (
              <>
                <p className="section-hint">
                  导入与提问时，文本分块会发送到阿里云百炼生成向量；向量与索引保存在本机。
                </p>
                <SecretField
                  label="阿里云百炼 API Key"
                  value={form.dashscopeApiKey}
                  onChange={(value) => update('dashscopeApiKey', value)}
                  placeholder="sk-..."
                  hint="留空则读取环境变量 DASHSCOPE_API_KEY"
                />
                <div className="field-grid">
                  <label className="full">
                    <span>Base URL</span>
                    <input
                      value={form.dashscopeBaseUrl}
                      onChange={(event) => update('dashscopeBaseUrl', event.target.value)}
                      placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                      spellCheck={false}
                    />
                    <small>百炼 OpenAI 兼容模式地址；也可以换成业务空间专属域名</small>
                  </label>
                  <label>
                    <span>嵌入模型</span>
                    <input
                      value={form.embedModel}
                      onChange={(event) => update('embedModel', event.target.value)}
                      spellCheck={false}
                    />
                    <small>默认 text-embedding-v4，单批最多 10 条，已自动分批</small>
                  </label>
                  <label>
                    <span>向量维度</span>
                    <select
                      value={form.embedDimensions}
                      onChange={(event) => update('embedDimensions', Number(event.target.value))}
                    >
                      {DASHSCOPE_EMBED_DIMENSIONS.map((dimension) => (
                        <option key={dimension} value={dimension}>
                          {dimension} 维
                        </option>
                      ))}
                    </select>
                    <small>默认 1024；更换后需要重建索引</small>
                  </label>
                </div>
              </>
            ) : form.embedProvider === 'openai' ? (
              <>
                <p className="section-hint">
                  使用 LM Studio 本地部署或任意 OpenAI 兼容嵌入服务；向量维度由服务返回结果自动识别。
                </p>
                <OpenAiCompatibleFields
                  baseUrl={form.openaiBaseUrl}
                  apiKey={form.openaiApiKey}
                  onBaseUrlChange={(value) => update('openaiBaseUrl', value)}
                  onApiKeyChange={(value) => update('openaiApiKey', value)}
                />
                <div className="field-grid">
                  <label className="full">
                    <span>嵌入模型</span>
                    <input
                      list="available-models"
                      value={form.embedModel}
                      onChange={(event) => update('embedModel', event.target.value)}
                      placeholder="填写服务已加载的嵌入模型名"
                      spellCheck={false}
                    />
                    <small>更换模型或服务后需要重建索引</small>
                  </label>
                </div>
              </>
            ) : (
              <div className="field-grid">
                <label>
                  <span>嵌入模型</span>
                  <input
                    list="available-models"
                    value={form.embedModel}
                    onChange={(event) => update('embedModel', event.target.value)}
                    spellCheck={false}
                  />
                  <small>中文推荐 bge-m3；更换后需重建索引</small>
                </label>
                <label>
                  <span>Ollama 地址</span>
                  <input
                    value={form.ollamaUrl}
                    onChange={(event) => update('ollamaUrl', event.target.value)}
                    placeholder="http://127.0.0.1:11434"
                    spellCheck={false}
                  />
                  <small>本地模式的连接地址</small>
                </label>
              </div>
            )}
            <ModelTags
              models={testResult?.embedModels ?? []}
              label="可用嵌入模型（点击填入）"
              onPick={(model) => update('embedModel', model)}
            />
          </section>

          <section className="settings-section">
            <h3>重排序</h3>
            <SwitchField
              label="使用 qwen3-rerank 重排序"
              hint="混合检索后让百炼对候选片段重新打分，提高引用命中率；关闭时不产生额外请求。"
              checked={form.rerankEnabled}
              onChange={(checked) => update('rerankEnabled', checked)}
            />
            {form.rerankEnabled ? (
              <>
                {form.embedProvider !== 'dashscope' ? (
                  <>
                    <SecretField
                      label="阿里云百炼 API Key"
                      value={form.dashscopeApiKey}
                      onChange={(value) => update('dashscopeApiKey', value)}
                      placeholder="sk-..."
                      hint="重排序使用百炼服务；嵌入不走百炼时也可在此单独填写"
                    />
                    <div className="field-grid">
                      <label className="full">
                        <span>百炼 Base URL</span>
                        <input
                          value={form.dashscopeBaseUrl}
                          onChange={(event) => update('dashscopeBaseUrl', event.target.value)}
                          placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                          spellCheck={false}
                        />
                        <small>重排序会自动推导到同一地域的接口地址</small>
                      </label>
                    </div>
                  </>
                ) : null}
                <div className="field-grid">
                  <label className="full">
                    <span>重排序模型</span>
                    <input
                      value={form.rerankModel}
                      onChange={(event) => update('rerankModel', event.target.value)}
                      placeholder="qwen3-rerank"
                      spellCheck={false}
                    />
                    <small>
                      默认 qwen3-rerank；使用上方百炼 Key 与地址。失败时会自动退回混合检索。
                    </small>
                  </label>
                </div>
              </>
            ) : null}
          </section>

          <section className="settings-section">
            <h3>检索与生成</h3>
            <div className="field-grid">
              <label>
                <span>引用片段数</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={form.topK}
                  onChange={(event) => update('topK', Number(event.target.value))}
                />
              </label>
              <label>
                <span>分块大小（字符）</span>
                <input
                  type="number"
                  min={200}
                  max={4000}
                  step={50}
                  value={form.chunkSize}
                  onChange={(event) => update('chunkSize', Number(event.target.value))}
                />
              </label>
              <label>
                <span>分块重叠（字符）</span>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={10}
                  value={form.chunkOverlap}
                  onChange={(event) => update('chunkOverlap', Number(event.target.value))}
                />
              </label>
              <label>
                <span>温度</span>
                <input
                  type="number"
                  min={0}
                  max={1.5}
                  step={0.1}
                  value={form.temperature}
                  onChange={(event) => update('temperature', Number(event.target.value))}
                />
              </label>
              <label className="full">
                <span>上下文字符上限</span>
                <input
                  type="number"
                  min={2000}
                  max={64000}
                  step={1000}
                  value={form.maxContextChars}
                  onChange={(event) => update('maxContextChars', Number(event.target.value))}
                />
                <small>交给模型的资料总量上限，越大越完整，但更慢</small>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>本地 Ollama 与图片识别</h3>
            <p className="section-hint">
              对话或嵌入切到「本地」时使用这里的地址；使用云端或远程兼容服务时，视觉模型留空即可走完全离线的
              OCR。
            </p>
            <div className="field-grid">
              <label className="full">
                <span>Ollama 地址</span>
                <input
                  value={form.ollamaUrl}
                  onChange={(event) => update('ollamaUrl', event.target.value)}
                  placeholder="http://127.0.0.1:11434"
                  spellCheck={false}
                />
              </label>
              <label className="full">
                <span>视觉模型（可选）</span>
                <input
                  list="available-models"
                  value={form.visionModel}
                  onChange={(event) => update('visionModel', event.target.value)}
                  placeholder="留空则图片走本地 OCR，例如 qwen2.5vl:3b"
                  spellCheck={false}
                />
                <small>填写后，导入图片时优先让视觉模型提取文字与描述</small>
              </label>
              <label className="full">
                <span>OCR 语言</span>
                <input
                  value={form.ocrLangs}
                  onChange={(event) => update('ocrLangs', event.target.value)}
                  placeholder="chi_sim+eng"
                  spellCheck={false}
                />
                <small>首次使用前在项目目录运行 npm run fetch-ocr 下载语言数据</small>
              </label>
            </div>
          </section>

          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <footer className="dialog-footer">
          <span className="footer-note">
            修改嵌入提供方、嵌入模型或分块参数后，请重建索引。
          </span>
          <div className="footer-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : null}
              保存设置
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
