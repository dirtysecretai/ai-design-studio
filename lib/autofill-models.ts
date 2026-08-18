// AutoFill (auto-caption) model whitelist — client-safe module shared by the
// dataset/onetrainer UIs and the auto-caption job processor.
//
// Keys are stored on AutoFillJob.modelKey. 'flash' and 'pro' are the legacy
// keys (old jobs keep their labels); the rest were verified available on this
// Gemini API key via models.list on 2026-08-17.
export const AUTOFILL_MODELS: { key: string; apiId: string; label: string }[] = [
  { key: 'flash',           apiId: 'gemini-3.1-flash-lite-preview', label: '3.1 Flash Lite' },
  { key: 'pro',             apiId: 'gemini-3.1-pro-preview',        label: '3.1 Pro' },
  { key: '3.5-flash-lite',  apiId: 'gemini-3.5-flash-lite',         label: '3.5 Flash Lite' },
  { key: '3.5-flash',       apiId: 'gemini-3.5-flash',              label: '3.5 Flash' },
  { key: '3.6-flash',       apiId: 'gemini-3.6-flash',              label: '3.6 Flash' },
  { key: '3.7-flash',       apiId: 'gemini-3.7-flash',              label: '3.7 Flash' },
]

export function autofillModelLabel(key: string | null | undefined): string {
  return AUTOFILL_MODELS.find(m => m.key === key)?.label ?? String(key ?? 'unknown')
}
