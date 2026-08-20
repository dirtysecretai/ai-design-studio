"use client"

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SitePageHeader, SiteBrandHero } from '@/components/SitePageHeader'

const REPORT_TYPES = [
  { value: 'illegal-content', label: 'Illegal content' },
  { value: 'non-consensual', label: 'Non-consensual content' },
  { value: 'underage-concern', label: 'Concern about a depicted person’s age' },
  { value: 'copyright', label: 'Copyright infringement' },
  { value: 'depicted-person-appeal', label: 'I am depicted in this content and want it removed (appeal)' },
  { value: 'other', label: 'Other' },
]

export default function ReportPage() {
  const [type, setType] = useState('illegal-content')
  const [contentUrl, setContentUrl] = useState('')
  const [description, setDescription] = useState('')
  const [reporterName, setReporterName] = useState('')
  const [reporterEmail, setReporterEmail] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reportId, setReportId] = useState<number | null>(null)

  const isAppeal = type === 'depicted-person-appeal'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!contentUrl.trim() || !description.trim()) {
      setError('Content URL and description are required')
      return
    }
    if (isAppeal && !reporterEmail.includes('@')) {
      setError('A contact email is required for removal appeals so we can follow up on the consent investigation')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/content-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          contentUrl: contentUrl.trim(),
          description: description.trim(),
          reporterName: reporterName.trim() || undefined,
          reporterEmail: reporterEmail.trim() || undefined,
          isDepictedPerson: isAppeal,
          website,
        }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setReportId(data.reportId)
      } else {
        setError(data.error || 'Failed to submit report')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'bg-slate-950 border-white/10 text-white focus-visible:ring-white/20'

  return (
    <div className="min-h-screen bg-[#050810] text-slate-100 flex flex-col">
      <SitePageHeader />

      {/* flex-1 + justify-center: portrait screens distribute the content down the
          page instead of leaving the bottom half empty; landscape still scrolls */}
      <main className="flex-1 flex flex-col justify-center max-w-2xl mx-auto w-full px-4 py-10 gap-8">
        <SiteBrandHero />

        <div>
          <h1 className="text-center text-lg font-bold text-white uppercase tracking-[0.2em] mb-1">Report Content</h1>
          <p className="text-center text-sm text-slate-500">
            Report illegal content, request removal of content depicting you, or flag anything that violates our{' '}
            <Link href="/terms" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Terms of Service</Link>.
            No account required.
          </p>
        </div>

        {reportId !== null ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Report Received</h2>
            <p className="text-slate-300 text-sm mb-2">
              Your report ID is <span className="font-mono text-white">#{reportId}</span>.
            </p>
            <p className="text-slate-400 text-sm mb-4 leading-relaxed">
              All reported complaints are reviewed and resolved within five (5) business days.
              Content confirmed to be illegal is removed immediately, and valid requests to remove
              non-consensual intimate imagery are actioned within 48 hours. If you provided an
              email address, we will contact you with the outcome.
            </p>
            <Link href="/" className="text-sm text-slate-400 hover:text-white underline underline-offset-2 decoration-slate-600">← Back to home</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">What are you reporting? *</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full h-9 rounded-md border border-white/10 bg-slate-950 text-white text-sm px-3 focus:outline-none focus:border-white/25"
              >
                {REPORT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Content URL *</label>
              <Input
                type="text"
                value={contentUrl}
                onChange={(e) => setContentUrl(e.target.value)}
                placeholder="Link to the content you are reporting"
                className={inputCls}
                required
                maxLength={2000}
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Description *</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the issue — what the content shows, why it should be removed, and any relevant details"
                className="w-full min-h-[120px] rounded-md border border-white/10 bg-slate-950 text-white text-sm p-3 placeholder:text-slate-600 focus:outline-none focus:border-white/25"
                required
                maxLength={5000}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Your Name (Optional)</label>
                <Input
                  type="text"
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                  placeholder="Name"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">
                  Your Email {isAppeal ? '*' : '(Optional)'}
                </label>
                <Input
                  type="email"
                  value={reporterEmail}
                  onChange={(e) => setReporterEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={inputCls}
                  required={isAppeal}
                />
                {isAppeal && (
                  <p className="text-xs text-slate-500 mt-1">
                    Required for removal appeals so we can contact you about the consent investigation.
                  </p>
                )}
              </div>
            </div>

            {/* Honeypot — hidden from real users, bots auto-fill it */}
            <input
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              name="website"
              tabIndex={-1}
              autoComplete="off"
              className="hidden"
              aria-hidden="true"
            />

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-white text-black font-bold hover:bg-slate-200"
            >
              {loading ? 'SUBMITTING…' : 'SUBMIT REPORT'}
            </Button>

            <div className="pt-2 border-t border-white/10 space-y-2">
              <p className="text-xs text-slate-500 leading-relaxed">
                All reported complaints are reviewed and resolved within <span className="text-slate-300">five (5) business days</span>.
                Content confirmed to be illegal is removed immediately, and valid requests to remove
                non-consensual intimate imagery are actioned within <span className="text-slate-300">48 hours</span>.
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                <span className="text-slate-300 font-semibold">Anti-Trafficking Statement:</span>{' '}
                Prompt &amp; Protocol LLC does not condone human sex trafficking in any form. All
                instances of suspected human trafficking will be reported to the proper authorities.
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                <span className="text-slate-300 font-semibold">18 U.S.C. § 2257 Exemption Statement:</span>{' '}
                All visual content on this service is 100% AI-generated. No real human performers are
                depicted, photographed, or recorded in any content available here. Because no content
                constitutes a depiction of actual sexually explicit conduct involving real persons,
                this service is exempt from the record-keeping requirements of 18 U.S.C. § 2257 and
                28 C.F.R. Part 75.
              </p>
              <p className="text-xs text-slate-500 leading-relaxed">
                If you are depicted in content on this service, you may appeal for its removal. If consent
                was not given or is void under applicable law, the content will be removed. Disagreements
                are resolved by a neutral third-party body at our expense. See our{' '}
                <Link href="/terms" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Terms of Service</Link>{' '}
                for details.
              </p>
              <p className="text-xs text-slate-500">
                You can also reach us at{' '}
                <a href="mailto:promptandprotocol@gmail.com" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">
                  promptandprotocol@gmail.com
                </a>
              </p>
            </div>
          </form>
        )}

        <div className="flex items-center justify-between text-xs text-slate-600">
          <p>© {new Date().getFullYear()} Prompt &amp; Protocol LLC · Orlando, Florida, USA</p>
          <Link href="/policies" className="text-slate-500 hover:text-slate-300 underline underline-offset-2 decoration-slate-700">
            Documents &amp; Policies
          </Link>
        </div>
      </main>
    </div>
  )
}
