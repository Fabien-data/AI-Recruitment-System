import { useState } from 'react'
import { Input } from './Input'
import { cmToFeetInches, feetInchesToCm, formatFeetInches } from '../../utils/height'

/**
 * Dual-unit height input. The canonical value is always centimetres: `valueCm`
 * is a cm string (or '') and `onChange` emits a cm string (or ''). The user can
 * toggle between entering centimetres and feet/inches — whichever they type is
 * converted to cm on the fly, so the saved value is unit-agnostic.
 */
export function HeightInput({ valueCm, onChange, label = 'Height' }) {
  const [unit, setUnit] = useState('cm') // 'cm' | 'ftin'
  const [feet, setFeet] = useState('')
  const [inches, setInches] = useState('')

  // Seed the ft/in fields from the canonical cm value when entering ft/in mode.
  function switchUnit(next) {
    if (next === unit) return
    if (next === 'ftin') {
      const fi = cmToFeetInches(valueCm)
      setFeet(fi ? String(fi.feet) : '')
      setInches(fi ? String(fi.inches) : '')
    }
    setUnit(next)
  }

  function emitFromFeetInches(f, i) {
    const cm = feetInchesToCm(f, i)
    onChange(cm == null ? '' : String(cm))
  }

  const cmPreview = unit === 'cm' ? formatFeetInches(valueCm) : null
  const ftinPreview = unit === 'ftin' ? feetInchesToCm(feet, inches) : null

  const toggleBtn = (value) =>
    `px-2.5 py-1 text-xs font-semibold transition-colors ${
      unit === value
        ? 'bg-primary-600 text-white dark:bg-primary-500'
        : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'
    }`

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 ml-1 tracking-tight">
          {label}
        </label>
        <div className="inline-flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
          <button type="button" onClick={() => switchUnit('cm')} className={toggleBtn('cm')}>cm</button>
          <button type="button" onClick={() => switchUnit('ftin')} className={toggleBtn('ftin')}>ft / in</button>
        </div>
      </div>

      {unit === 'cm' ? (
        <Input
          type="number"
          min="1"
          max="300"
          value={valueCm}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. 170"
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="number"
            min="0"
            max="9"
            value={feet}
            onChange={(e) => { setFeet(e.target.value); emitFromFeetInches(e.target.value, inches) }}
            placeholder="ft"
          />
          <Input
            type="number"
            min="0"
            max="11"
            value={inches}
            onChange={(e) => { setInches(e.target.value); emitFromFeetInches(feet, e.target.value) }}
            placeholder="in"
          />
        </div>
      )}

      <p className="mt-1 ml-1 text-xs text-zinc-500 dark:text-zinc-400">
        {unit === 'cm'
          ? (cmPreview ? `≈ ${cmPreview}` : 'Enter in cm or ft/in — saved in centimetres')
          : (ftinPreview ? `≈ ${ftinPreview} cm` : 'Enter in cm or ft/in — saved in centimetres')}
      </p>
    </div>
  )
}
