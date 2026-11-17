import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
}

export default function SecretField({
  label,
  value,
  onChange,
  placeholder,
  hint
}: Props) {
  const [visible, setVisible] = useState(false)

  return (
    <label className="secret-field">
      <span>{label}</span>
      <div className="secret-input">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="secret-toggle"
          onClick={() => setVisible((current) => !current)}
          title={visible ? '隐藏密钥' : '显示密钥'}
          aria-label={visible ? '隐藏密钥' : '显示密钥'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}
