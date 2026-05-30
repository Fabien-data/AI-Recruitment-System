// Deterministic color assignment for open-ended category values (job role,
// project, sector, country, …). The same input always maps to the same tone,
// and brand-new values automatically spread across the palette — so jobs and
// projects added later get distinct colors with zero code edits.
//
// IMPORTANT (Tailwind JIT): every class string below must appear LITERALLY in
// source. Tailwind only emits classes whose complete string is present at build
// time — there is no `safelist` in tailwind.config.js. Never build a class name
// by interpolation (e.g. `bg-${hue}-100`); that would render colorless. The
// hash only picks an index into this fixed array of full literal strings.

const PALETTE = [
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
]

const NEUTRAL = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'

/**
 * Map any string to a stable Tailwind tone (bg + text, with dark variants).
 * Case/space-insensitive so "F&B Service" and "f&b service" share a color.
 * Empty/nullish input returns a neutral tone.
 * @param {string} value
 * @returns {string} space-separated Tailwind classes
 */
export function categoryColor(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return NEUTRAL
  // FNV-1a 32-bit hash — fast, well-distributed for short strings.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return PALETTE[h % PALETTE.length]
}

export default categoryColor
