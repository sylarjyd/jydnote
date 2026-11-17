import { Check, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '../../../shared/types'

interface Props {
  value: ThemeMode
  onChange: (theme: ThemeMode) => void
}

const OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'light', label: '浅色', hint: '暖白纸张' },
  { value: 'dark', label: '深色', hint: '低光护眼' }
]

export default function ThemePicker({ value, onChange }: Props) {
  return (
    <div className="theme-picker" role="radiogroup" aria-label="主题颜色">
      {OPTIONS.map((option) => {
        const active = option.value === value
        const Icon = option.value === 'light' ? Sun : Moon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`theme-option${active ? ' selected' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span className={`theme-preview ${option.value}`} aria-hidden="true">
              <span className="theme-preview-sidebar" />
              <span className="theme-preview-canvas">
                <span className="theme-preview-bar" />
                <span className="theme-preview-line" />
                <span className="theme-preview-line short" />
                <span className="theme-preview-card" />
              </span>
            </span>
            <span className="theme-option-label">
              <Icon size={14} />
              <span className="theme-option-text">
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
              <span className="theme-option-check">{active ? <Check size={13} /> : null}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
