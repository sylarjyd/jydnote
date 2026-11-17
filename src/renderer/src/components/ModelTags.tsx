interface Props {
  models: string[]
  onPick: (model: string) => void
  label?: string
}

/** 测试连接后返回的模型列表，点击即可填入当前模型输入框 */
export default function ModelTags({ models, onPick, label }: Props) {
  if (!models.length) return null

  return (
    <div className="model-tags">
      {label ? <span className="model-tags-label">{label}</span> : null}
      {models.slice(0, 24).map((model) => (
        <button key={model} type="button" title={`使用 ${model}`} onClick={() => onPick(model)}>
          {model}
        </button>
      ))}
    </div>
  )
}
