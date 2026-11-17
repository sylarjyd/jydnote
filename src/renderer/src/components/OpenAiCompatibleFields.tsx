import SecretField from './SecretField'

interface Props {
  baseUrl: string
  apiKey: string
  onBaseUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
}

/** LM Studio 与任意 OpenAI 兼容 API 共用的连接配置 */
export default function OpenAiCompatibleFields({
  baseUrl,
  apiKey,
  onBaseUrlChange,
  onApiKeyChange
}: Props) {
  return (
    <>
      <div className="field-grid">
        <label className="full">
          <span>服务地址</span>
          <input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="http://127.0.0.1:1234/v1"
            spellCheck={false}
          />
          <small>LM Studio 默认 http://127.0.0.1:1234/v1；也可填任意 OpenAI 兼容 API</small>
        </label>
      </div>
      <SecretField
        label="API Key（可选）"
        value={apiKey}
        onChange={onApiKeyChange}
        placeholder="LM Studio 默认不需要"
        hint="本地 LM Studio 通常留空；调用云端兼容 API 时填写"
      />
    </>
  )
}
