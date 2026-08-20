import { Metadata } from 'next'
import { SitePageHeader, SiteBrandHero } from '@/components/SitePageHeader'

export const metadata: Metadata = {
  title: 'Terms of Service | AI Design Studio',
  description: 'Terms of Service for AI Design Studio AI image generation platform',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#050810] text-slate-100">
      <SitePageHeader />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-10">
          <SiteBrandHero />
        </div>
        <h1 className="text-center text-lg font-bold text-white uppercase tracking-[0.2em] mb-1">
          Terms of Service
        </h1>
        <p className="text-center text-sm text-slate-500 mb-10">Last Updated: July 27, 2026 | Version 4.3</p>

        <div className="space-y-8 text-slate-300">
          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">1. Acceptance of Terms</h2>
            <p className="mb-4">
              By accessing or using AI Design Studio ("the Service"), operated by Prompt & Protocol LLC, you agree to be bound by these Terms of Service ("Terms").
              If you do not agree to these Terms, do not use the Service.
            </p>
            <p className="mb-4 font-bold text-amber-300">
              You must be at least 18 years of age to use this Service. Our service is not directed at or intended for individuals
              under the age of 18. By using the Service, you represent and warrant that you are at least 18 years old.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">2. Service Description</h2>
            <p className="mb-4">
              AI Design Studio is a unified AI creative platform that provides access to multiple state-of-the-art AI image and video
              generation models through a single interface. The platform is accessed via the AI Design Studio web application and
              is powered by third-party AI providers including fal.ai, OpenAI, Google, and ByteDance.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">2.1 Image Generation</h3>
            <p className="mb-2">The following image generation models are currently available to users:</p>
            <ul className="list-disc list-inside space-y-1 ml-4 mb-4">
              <li><strong>NanoBanana Pro 2</strong> (Google Gemini) — High-quality image generation up to 4K</li>
              <li><strong>SeeDream 4.5</strong> (ByteDance) — Photorealistic and stylized image generation</li>
              <li><strong>FLUX.1 Dev</strong> (Black Forest Labs) — High-fidelity text-to-image generation</li>
              <li><strong>Wan 2.7 Pro</strong> — Advanced image generation with reference support</li>
              <li><strong>ChatGPT Images 2.0</strong> (OpenAI) — Instruction-following image generation</li>
              <li><strong>Z-Image Base / Z-Image Turbo</strong> — Fast and versatile image generation</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">2.2 Video Generation</h3>
            <p className="mb-2">The following video generation models are currently available to users:</p>
            <ul className="list-disc list-inside space-y-1 ml-4 mb-4">
              <li><strong>WAN 2.5</strong> — Text-to-video and image-to-video generation</li>
              <li><strong>SeeDance 1.5</strong> — High-quality video generation with audio support</li>
              <li><strong>SeeDance 2.0 / SeeDance 2.0 Fast</strong> — Advanced video generation in multiple resolutions</li>
              <li><strong>Kling 3.0</strong> (Kuaishou) — Text-to-video with optional AI audio, 3–15 seconds</li>
              <li><strong>Kling v3 Motion</strong> — Motion-controlled video generation</li>
              <li><strong>Happy Horse</strong> — Stylized video generation</li>
              <li><strong>Lipsync v3</strong> — AI-powered lip sync for existing video</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">2.3 Platform Features</h3>
            <p className="mb-2">The AI Design Studio interface provides the following capabilities:</p>
            <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
              <li><strong>Unified Generation Feed</strong> — All generated images and videos appear in a live session feed with real-time status updates</li>
              <li><strong>Reference Image Support</strong> — Upload reference images to guide and influence generation output</li>
              <li><strong>Multi-Queue Generation</strong> — Submit multiple generation jobs concurrently across different models</li>
              <li><strong>My Images Gallery</strong> — Persistent cloud storage of all your past generations, accessible at any time</li>
              <li><strong>Prompt Controls</strong> — Per-model configuration including resolution, aspect ratio, duration, quality, and model-specific parameters</li>
              <li><strong>Content Safety Controls</strong> — Built-in content safety filtering on applicable models to maintain platform compliance</li>
            </ul>

            <p className="mt-4 font-semibold text-amber-300">
              IMPORTANT: The Service includes experimental AI technology that may sometimes produce inaccurate, unexpected, or
              unintended content. Generated outputs should never be relied upon as professional advice for medical, legal,
              financial, or safety-critical purposes. Model availability is subject to change without notice.
            </p>
            <p className="mt-4">By using this Service, you acknowledge that:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>All outputs are generated by artificial intelligence and may be imperfect or unexpected</li>
              <li>Generated content may contain invisible digital watermarks or metadata identifying its AI origin</li>
              <li>Model availability, features, and pricing are subject to change</li>
              <li>AI models have inherent limitations, biases, and may produce inconsistent results</li>
              <li>Certain models apply content safety filtering which cannot be disabled by standard users</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">3. Third-Party Services & Compliance</h2>
            <p className="mb-4">
              Our Service utilizes third-party AI providers. By using our Service, you acknowledge and agree that:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Your use of the Service is also subject to the terms and policies of these third-party providers</li>
              <li>We do not control these third-party services and are not responsible for their availability, functionality, or content</li>
              <li>These providers may have their own data collection and usage policies</li>
              <li>Service availability may be affected by third-party service interruptions or limitations</li>
              <li>We may share your prompts and generated content with these providers as necessary to provide the Service</li>
            </ul>
            <p className="mt-4">You can review the terms of our third-party providers:</p>
            <ul className="list-disc list-inside space-y-2 ml-4 mt-2">
              <li><a href="https://fal.ai/terms" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">fal.ai Terms of Service</a></li>
              <li><a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Google Gemini API Terms of Service</a></li>
              <li><a href="https://fal.ai/privacy" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">fal.ai Privacy Policy</a></li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">4. User Account and Access</h2>
            <p className="mb-4">To access the Service, you must create an account using Clerk authentication. You are responsible for:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Maintaining the confidentiality of your account credentials</li>
              <li>All activities that occur under your account</li>
              <li>Notifying us immediately of any unauthorized use of your account</li>
              <li>Ensuring your account information is accurate and current</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">5. Tickets and Subscriptions</h2>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">5.1 Ticket System</h3>
            <p className="mb-4">
              The Service operates on a ticket-based system. Each generation request consumes tickets based on the model, quality
              setting, resolution, and duration selected. Costs below reflect standard settings; higher quality or resolution
              options increase the ticket cost accordingly.
            </p>

            <p className="mb-2 font-semibold text-slate-200">Image Generation Models:</p>
            <ul className="list-disc list-inside space-y-1 ml-4 text-sm mb-4">
              <li><strong>NanoBanana Pro:</strong> 7 tickets (2K) · 14 tickets (4K)</li>
              <li><strong>NanoBanana Pro 2:</strong> 7 tickets (2K) · 12 tickets (4K) per image</li>
              <li><strong>SeeDream 4.5:</strong> 2 tickets (2K) · 4 tickets (4K)</li>
              <li><strong>FLUX.1 Dev:</strong> 2–8 tickets (varies by quality and use of reference images)</li>
              <li><strong>Wan 2.7 Pro:</strong> 4 tickets per generation</li>
              <li><strong>ChatGPT Images 2.0:</strong> 1–15 tickets (varies by quality and resolution)</li>
              <li><strong>Z-Image Base:</strong> 1 ticket (1K) · 4 tickets (2K) · 15 tickets (4K)</li>
              <li><strong>Z-Image Turbo:</strong> 1–17 tickets (varies by quality and LoRA usage)</li>
            </ul>

            <p className="mb-2 font-semibold text-slate-200">Video Generation Models:</p>
            <ul className="list-disc list-inside space-y-1 ml-4 text-sm mb-4">
              <li><strong>WAN 2.5:</strong> 7–40 tickets (varies by resolution and duration)
                <ul className="list-disc list-inside ml-6 mt-1 space-y-0.5">
                  <li>480p: 7 tickets (5s) · 14 tickets (10s)</li>
                  <li>720p: 13 tickets (5s) · 26 tickets (10s)</li>
                  <li>1080p: 20 tickets (5s) · 40 tickets (10s)</li>
                </ul>
              </li>
              <li><strong>SeeDance 1.5:</strong> Varies by duration, resolution, and audio — approximately 1–45 tickets</li>
              <li><strong>SeeDance 2.0:</strong> Approximately 15 tickets/second × resolution multiplier (0.5–2.25×)</li>
              <li><strong>SeeDance 2.0 Fast:</strong> Approximately 12 tickets/second × resolution multiplier (0.5–2.25×)</li>
              <li><strong>Kling 3.0:</strong> 6 tickets/second without audio · 8 tickets/second with audio (3–15 seconds)</li>
              <li><strong>Kling v3 Motion:</strong> 6 tickets/second, up to 30 seconds</li>
              <li><strong>Happy Horse:</strong> 7 tickets/second (720p) · 12 tickets/second (1080p)</li>
              <li><strong>Lipsync v3:</strong> Minimum 10 tickets · 6 tickets/second of source video</li>
            </ul>

            <p className="mt-2 text-sm text-amber-300">Ticket costs are deducted at the time of a successful generation and are non-refundable once consumed. Pricing is subject to change with notice.</p>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">5.2 Dev Tier Subscriptions</h3>
            <p className="mb-4">We offer recurring subscription plans ("Dev Tier") that provide periodic ticket allocations and a discount on one-time ticket purchases:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li><strong>Biweekly Plan:</strong> $20 USD every 2 weeks — 250 tickets per cycle</li>
              <li><strong>Monthly Plan:</strong> $40 USD per month — 500 tickets per cycle</li>
              <li><strong>Yearly Plan:</strong> $480 USD per year — 500 tickets per month (6,000 tickets annually, allocated upfront)</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">5.3 Subscription Terms</h3>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Subscriptions automatically renew unless canceled before the next billing cycle</li>
              <li>Tickets are allocated at the start of each billing cycle</li>
              <li>Unused tickets do not roll over to the next billing cycle</li>
              <li>You may cancel your subscription at any time through your account settings</li>
              <li>Cancellation takes effect at the end of the current billing period</li>
              <li><strong>No refunds are provided for partial billing periods or unused tickets</strong></li>
              <li>We reserve the right to modify subscription pricing with 30 days advance notice</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">5.4 Payment Processing</h3>
            <p className="mb-4">
              All payments are processed through <strong>CCBill</strong>, a third-party payment processing service. CCBill manages
              payment authorization, billing, and transaction security on our behalf. By completing a purchase, you agree to
              CCBill's applicable terms and privacy policy. We are not responsible for any issues arising from CCBill's payment
              processing services, including but not limited to payment failures, security incidents, or unauthorized transactions.
            </p>
            <p className="mb-4">
              If you have a billing dispute or question about a charge, please contact us at{' '}
              <a href="mailto:promptandprotocol@gmail.com" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">promptandprotocol@gmail.com</a>{' '}
              before initiating a chargeback. Chargebacks initiated without prior contact may result in immediate account suspension.
            </p>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">5.5 One-Time Ticket Purchases</h3>
            <p className="mb-4">
              All one-time ticket purchases are <strong>final and non-refundable</strong> once the transaction is completed. This includes:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Unsuccessful generations due to prohibited content or safety filters</li>
              <li>User dissatisfaction with AI-generated results</li>
              <li>Technical issues with third-party AI providers</li>
              <li>Account suspension or termination for violations</li>
            </ul>
            <p className="mt-4">
              Tickets currently do not expire, but we reserve the right to modify this policy with 30 days' written notice.
            </p>
          </section>

          <section className="border-2 border-red-500/30 bg-red-500/5 p-6 rounded-lg">
            <h2 className="text-2xl font-bold mb-4 text-red-400">6. Prohibited Use Policy</h2>
            <p className="mb-4">
              This Service operates under requirements established by our payment processor (CCBill) and the applicable card brand
              standards of Visa, Mastercard, and Discover. The following prohibitions apply to all users without exception.
            </p>

            <h3 className="text-lg font-semibold mb-2 mt-4 text-red-300">6.1 Non-Consensual Use of Image or Likeness</h3>
            <p className="mb-3">
              You may not use this Service to generate content depicting any real, identifiable person unless verifiable consent
              from that person has been established and is on record. This includes but is not limited to:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4 mb-3">
              <li>Deepfakes or synthetic media portraying a real person's image or likeness without their explicit consent</li>
              <li>Intimate, sexual, or compromising depictions of any real person without documented consent</li>
              <li>Any content where the subject's identity is recognizable and no consent record exists</li>
            </ul>
            <p className="mb-3 text-sm text-slate-400">
              Per card brand requirements: if content includes the image or strong likeness of an actual person who has not
              provided consent, such content is considered a violation of Visa, Mastercard, and Discover standards and must not be
              published or must be removed immediately. Where consent is disputed, resolution must be handled by a neutral
              arbitrator at the content creator's expense.
            </p>

            <h3 className="text-lg font-semibold mb-2 mt-4 text-red-300">6.2 Absolutely Prohibited Content Categories</h3>
            <p className="mb-3 font-bold">You agree NOT to use the Service to generate or create any content involving:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li><strong>Minors</strong> — Any sexual, suggestive, or exploitative content depicting individuals under 18 years of age, including animated, illustrated, or simulated depictions; content depicting subjects in diapers or in childlike scenarios is also prohibited</li>
              <li><strong>Non-consensual scenarios</strong> — Content depicting sexual activity or intimacy involving individuals who are asleep, unconscious, coerced, or otherwise non-consenting</li>
              <li><strong>Deepfakes of real persons</strong> — Synthetic media that replaces or fabricates the likeness of a real, identifiable individual without their documented consent</li>
              <li><strong>Incest</strong> — Any content depicting or simulating sexual activity between family members</li>
              <li><strong>Bestiality or animal cruelty</strong> — Sexual content involving animals, or any depiction of animal cruelty</li>
              <li><strong>Watersports</strong> — Content depicting urination in a sexual context</li>
              <li><strong>Violence, abduction, or snuff</strong> — Graphic violence, murder, abduction scenarios, or fantasy snuff content</li>
              <li><strong>Substance-facilitated scenarios</strong> — Sexual content involving individuals depicted as under the influence of drugs, alcohol, or hypnosis</li>
              <li><strong>Prostitution or escorting</strong> — Content soliciting, simulating, or promoting paid sexual services</li>
              <li><strong>Polygamy scenarios</strong> — Content framed around or promoting polygamous arrangements in a sexual context</li>
              <li><strong>Hate speech or targeted harassment</strong> — Content targeting individuals or groups based on race, religion, gender, sexuality, national origin, or other protected characteristics</li>
              <li><strong>Instructions for illegal activity</strong> — Content providing guidance for building weapons, engaging in criminal acts, or any other illegal conduct</li>
              <li><strong>Professional advice</strong> — Content presented as or intended to substitute for medical, legal, financial, gambling, or other licensed professional advice</li>
            </ul>

            <h3 className="text-lg font-semibold mb-2 mt-6 text-red-300">6.3 Copyright and Intellectual Property</h3>
            <p className="mb-3">
              Copyright infringement is strictly prohibited. You may not use this Service to generate content that reproduces,
              imitates, or incorporates copyrighted material without the rights holder's permission. This includes:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Reproducing or closely imitating copyrighted images, artwork, characters, or designs</li>
              <li>Generating content that incorporates protected trademarks or logos without authorization</li>
              <li>Repurposing or creating derivative works from copyrighted material without a license</li>
            </ul>

            <h3 className="text-lg font-semibold mb-2 mt-6 text-red-300">6.4 Platform Integrity</h3>
            <p className="mb-2">Additionally, you agree NOT to:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Attempt to bypass, circumvent, or disable any content safety filters or platform restrictions</li>
              <li>Reverse engineer, extract, or replicate the underlying AI models or platform code</li>
              <li>Use the Service for safety-critical applications (medical devices, autonomous systems, etc.)</li>
              <li>Use the Service to develop or train competing AI models or services</li>
              <li>Submit sensitive personal information, confidential data, or protected health information</li>
              <li>Violate the acceptable use policies of any third-party AI providers used by this Service</li>
            </ul>

            <p className="mt-6 font-bold text-red-400 text-lg">
              ⚠️ Violation of this Prohibited Use Policy will result in immediate permanent account termination without refund of
              remaining tickets or subscription fees. We reserve the right to report violations to applicable authorities and
              card networks.
            </p>

            <p className="mt-4 text-sm text-slate-400">
              See also Section 21 (Content Provider Agreement) and Section 22 (Content Removal, Complaints &amp; Appeals).
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">7. Content and Intellectual Property</h2>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">7.1 Your Content</h3>
            <p className="mb-4">
              You retain ownership of the text prompts and inputs ("Your Content") that you submit to the Service. By submitting
              Your Content, you grant us a worldwide, non-exclusive, royalty-free license to:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Use, process, and transmit Your Content to provide the Service</li>
              <li>Share Your Content with our third-party AI providers (fal.ai, Google Gemini) for processing</li>
              <li>Use anonymized prompts and usage data to improve our service (no images shared without consent)</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">7.2 Generated Content</h3>
            <p className="mb-4">
              Subject to your compliance with these Terms and payment of applicable fees, you may use the generated images
              ("Generated Content") for your personal or commercial purposes. However, you acknowledge that:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>We and our AI providers may generate similar or identical content for other users</li>
              <li>We do not guarantee the uniqueness or originality of Generated Content</li>
              <li>AI-generated images may have limited copyright protection under current law</li>
              <li>Fully automated AI outputs may not qualify for copyright without significant human modification</li>
              <li>You are solely responsible for ensuring Generated Content does not infringe third-party rights</li>
              <li>You must comply with all applicable laws when using Generated Content</li>
              <li>Certain AI models may have restrictions on commercial use - you are responsible for compliance</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">7.3 Image Storage & Deletion</h3>
            <div className="bg-amber-500/[0.06] border border-amber-500/25 p-4 rounded-lg mb-3">
              <p className="font-bold text-amber-300 mb-2">⚠️ IMPORTANT: Download Responsibility</p>
              <p>You are <strong>solely responsible</strong> for downloading and backing up your generated images. We provide temporary storage only.</p>
            </div>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Images are stored for <strong>30 days maximum</strong> on secure cloud servers (Vercel Blob Storage)</li>
              <li>After 30 days, images are <strong>permanently and automatically deleted</strong></li>
              <li>We do not offer image recovery services after deletion</li>
              <li>Storage duration may be reduced with notice during periods of high storage costs</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3 mt-6 text-slate-300">7.4 Service Content</h3>
            <p className="mb-4">
              The Service, including its design, code, features, and functionality, is owned by Prompt & Protocol LLC and is protected
              by copyright, trademark, and other intellectual property laws. You may not copy, modify, distribute, or create
              derivative works based on the Service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">8. Data Usage and Privacy</h2>
            <p className="mb-4">
              Your use of the Service is subject to our Privacy Policy. Please review our <a href="/privacy" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Privacy Policy</a> to understand how we collect, use, and protect your information.
            </p>
            <p className="mb-4 font-semibold text-amber-300">
              IMPORTANT DATA SHARING NOTICE:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li><strong>fal.ai:</strong> When using models through fal.ai, your prompts and generated content may be used by fal.ai to improve their services, subject to fal.ai's terms</li>
              <li><strong>Google Gemini (Unpaid Services):</strong> When using unpaid Gemini services, Google uses submitted content and generated responses to improve their products and machine learning technologies</li>
              <li><strong>Google Gemini (Paid Services):</strong> When using paid Gemini services, Google does not use prompts/responses for improvement but logs them for 30 days for violation detection</li>
              <li><strong>Do not submit sensitive, confidential, or personal information to the Service</strong></li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">9. Service Availability and Modifications</h2>
            <p className="mb-4">We reserve the right to:</p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Modify, suspend, or discontinue any aspect of the Service at any time</li>
              <li>Change pricing, features, or ticket allocation with reasonable notice (30 days for material changes)</li>
              <li>Impose usage limits or rate limits on the Service to prevent abuse</li>
              <li>Update these Terms at any time by posting revised Terms on the Service</li>
            </ul>
            <p className="mt-4">
              The Service is provided "as available" and may experience downtime due to maintenance, third-party service issues
              (fal.ai, Google Gemini), or other factors beyond our control. We do not guarantee uninterrupted service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">10. Geographic Restrictions</h2>
            <p className="mb-4">
              The Service may not be available in all geographic regions. Due to third-party AI provider restrictions (specifically
              Google Gemini API requirements), users in the European Economic Area (EEA), Switzerland, and United Kingdom may be
              required to use paid services only. We reserve the right to limit Service availability based on geographic location.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">11. Disclaimer of Warranties</h2>
            <div className="bg-white/[0.03] border-2 border-white/10 p-4 rounded-lg">
              <p className="mb-3 font-bold text-white uppercase">
                THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
                INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT,
                OR ACCURACY.
              </p>
              <p className="mb-3">We specifically disclaim any warranties regarding:</p>
              <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
                <li>The accuracy, quality, appropriateness, or suitability of Generated Content for any purpose</li>
                <li>Uninterrupted or error-free operation of the Service</li>
                <li>The security or privacy of data transmitted through the Service</li>
                <li>The availability or performance of third-party AI providers (fal.ai, Google Gemini)</li>
                <li>The uniqueness or non-infringement of Generated Content</li>
                <li>The results you may obtain from using the Service</li>
              </ul>
              <p className="mt-3 font-semibold text-amber-300">
                YOU ASSUME ALL RISK FOR YOUR USE OF THE SERVICE AND GENERATED CONTENT.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">12. Limitation of Liability</h2>
            <div className="bg-white/[0.03] border-2 border-white/10 p-4 rounded-lg">
              <p className="mb-3 font-bold text-white uppercase">
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, PROMPT & PROTOCOL LLC, ITS AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, AND
                AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS
                OF PROFITS, REVENUE, DATA, OR USE, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE, WHETHER BASED ON WARRANTY,
                CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL THEORY.
              </p>
              <p className="mb-3">This includes but is not limited to damages arising from:</p>
              <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
                <li>Errors, mistakes, or inaccuracies in Generated Content</li>
                <li>Loss of data, including generated images after the 30-day retention period</li>
                <li>Unauthorized access to or alteration of your account or data</li>
                <li>Third-party service interruptions or failures (fal.ai, Google Gemini, CCBill)</li>
                <li>Infringement claims related to Generated Content</li>
                <li>Account suspension or termination</li>
              </ul>
              <p className="mt-3 font-bold">
                OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THE SERVICE SHALL NOT EXCEED THE AMOUNT
                YOU PAID TO US IN THE 12 MONTHS PRECEDING THE CLAIM, OR $100 USD, WHICHEVER IS GREATER.
              </p>
              <p className="mt-3 text-xs text-slate-400">
                Some jurisdictions do not allow limitation of liability for incidental or consequential damages, so these limitations
                may not apply to you.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">13. Indemnification</h2>
            <p className="mb-4">
              You agree to indemnify, defend, and hold harmless Prompt & Protocol LLC, its affiliates, and their respective officers,
              directors, employees, and agents from and against any claims, liabilities, damages, losses, costs, and expenses
              (including reasonable attorneys' fees) arising out of or relating to:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Your use of the Service or Generated Content</li>
              <li>Your violation of these Terms or applicable laws</li>
              <li>Your infringement of any third-party rights, including intellectual property, privacy, or publicity rights</li>
              <li>Your Content or any content you submit to the Service</li>
              <li>Your violation of third-party provider terms (fal.ai, Google Gemini)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">14. Account Suspension and Termination</h2>
            <p className="mb-4">
              We reserve the right to suspend or terminate your account and access to the Service at any time, with or without notice, for:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Violation of these Terms or our Acceptable Use Policy</li>
              <li>Fraudulent activity, payment disputes, or chargebacks</li>
              <li>Non-payment of fees within 10 days of the due date</li>
              <li>Court orders, legal requirements, or law enforcement requests</li>
              <li>Security incidents or suspicious activity</li>
              <li>Interference with the normal operation of the Service</li>
              <li>Excessive or abusive usage patterns</li>
              <li>Any conduct we deem harmful to our service, other users, or third parties</li>
            </ul>
            <p className="mt-4 font-semibold text-amber-300">
              Upon termination, your right to use the Service immediately ceases, and any unused tickets or subscription benefits
              will be forfeited without refund.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">15. Dispute Resolution and Arbitration</h2>
            <p className="mb-4">
              Any dispute arising out of or relating to these Terms or the Service shall be resolved through binding arbitration
              in accordance with the rules of the American Arbitration Association. The arbitration shall take place in the
              State of Florida, United States.
            </p>
            <p className="mb-4">
              <strong>Class Action Waiver:</strong> You agree to resolve disputes on an individual basis only and waive any right
              to participate in class action lawsuits or class-wide arbitration.
            </p>
            <p className="mb-4">
              <strong>Opt-Out Right:</strong> You may opt out of arbitration by sending written notice to{' '}
              <a href="mailto:promptandprotocol@gmail.com" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">promptandprotocol@gmail.com</a>{' '}
              within 30 days of first accepting these Terms. Your opt-out notice must include your name, address, and a clear
              statement that you wish to opt out of arbitration.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">16. Governing Law</h2>
            <p className="mb-4">
              These Terms shall be governed by and construed in accordance with the laws of the State of Florida, United States,
              without regard to its conflict of law provisions. Any legal action or proceeding (if arbitration is opted out or
              unavailable) shall be brought exclusively in the courts of Florida.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">17. Changes to Terms</h2>
            <p className="mb-4">
              We may update these Terms from time to time. We may notify you of material changes by:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Posting the updated Terms on the Service with an updated "Last Updated" date</li>
              <li>Sending email notification to registered users (for material changes)</li>
              <li>Providing 30 days advance notice for changes affecting pricing or subscription terms</li>
            </ul>
            <p className="mt-4">
              Your continued use of the Service after changes take effect constitutes acceptance of the revised Terms.
              If you do not agree to the updated Terms, you must stop using the Service and may cancel your subscription.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">18. Severability</h2>
            <p className="mb-4">
              If any provision of these Terms is found to be invalid, illegal, or unenforceable, the remaining provisions shall
              continue in full force and effect to the maximum extent possible.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">19. Entire Agreement</h2>
            <p className="mb-4">
              These Terms, together with our <a href="/privacy" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Privacy Policy</a> and{' '}
              <a href="/refund" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">Refund Policy</a>, constitute the entire agreement between you
              and Prompt &amp; Protocol LLC regarding the Service and supersede all prior agreements and understandings.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">20. Contact Information</h2>
            <p className="mb-4">
              For questions about these Terms, please contact us at:{' '}
              <a href="mailto:promptandprotocol@gmail.com" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">
                promptandprotocol@gmail.com
              </a>
            </p>
            <p className="text-sm text-slate-400">
              Support is provided in English only. Response times may vary.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">21. Content Provider Agreement</h2>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.1 Scope and Verified Providers</h3>
            <p className="mb-4">
              Any user who submits prompts, uploads reference images, or otherwise causes content to be created or stored on the
              Service (a "Content Provider") enters into this Content Provider Agreement, which forms a binding part of these
              Terms. Only registered account holders who have accepted these Terms and completed our 18+ age certification may
              act as Content Providers. Anonymous content submission is not permitted.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.2 Prohibited Conduct</h3>
            <p className="mb-4">
              Content Providers shall not create, upload, or distribute content that is illegal under applicable law or that
              violates the rules of the card networks (including Visa and Mastercard) or of our payment processors. Content that
              promotes or facilitates human trafficking, sex trafficking, or physical abuse, and any depiction of non-consensual
              activity, is strictly prohibited, in addition to everything listed in Section 6 (Prohibited Use Policy).
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.3 Consent of Depicted Persons</h3>
            <p className="mb-4">
              If any real, identifiable person appears in or is depicted by content you create on the Service — including through
              uploaded reference images or likeness-based prompts — you must first obtain, and keep on record, that person's
              written consent to (a) be depicted in the content, (b) the public distribution of the content, and (c) the upload
              of the content to, and (where such functionality is available) its download from, the Service. You must provide
              copies of such consent records to us promptly upon request.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.4 Age and Identity Verification of Depicted Persons</h3>
            <p className="mb-4">
              You must verify the identity and age of every real person depicted in your content and you represent and warrant
              that all depicted persons are above the legal age of majority. Supporting documentation must be retained and
              produced to us or to our payment processor upon request. Content that depicts or appears to depict minors in any
              sexual or suggestive context is absolutely prohibited and will be reported to the appropriate authorities.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.5 Content Review and Moderation</h3>
            <p className="mb-4">
              All content on the Service is subject to review both before and after publication. We employ automated safety
              filters and human moderation, and we may remove any content, refuse any generation request, or suspend or
              terminate any account at our sole discretion, with or without notice.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.6 Marketing Restrictions</h3>
            <p className="mb-4">
              You may not use — and we do not permit — marketing, promotion, or content search terms that state or imply the
              availability of child sexual abuse material, non-consensual activity, or any other illegal content.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.7 AI-Generated Content Notice</h3>
            <p className="mb-4">
              All visual content produced by the Service is synthetic, generated by artificial intelligence models, and does not
              depict real events. This notice does not exempt Content Providers from the obligations in Sections 21.3 and 21.4
              where the likeness of a real person is used.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.8 Anti-Trafficking Statement</h3>
            <p className="mb-4">
              We do not condone human sex trafficking in any form, and content that promotes, facilitates, or depicts human
              trafficking is strictly prohibited on the Service. All instances of suspected human trafficking will be reported
              to the proper authorities.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">21.9 18 U.S.C. § 2257 Exemption Statement</h3>
            <p className="mb-4">
              All visual content on the Service is 100% AI-generated. No real human performers are depicted, photographed, or
              recorded in any content available on the Service. Because no content on the Service constitutes a depiction of
              actual sexually explicit conduct involving real persons, the Service is exempt from the record-keeping
              requirements of 18 U.S.C. § 2257 and 28 C.F.R. Part 75.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-4 text-white">22. Content Removal, Complaints &amp; Appeals</h2>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">22.1 How to Report Content</h3>
            <p className="mb-4">
              Anyone — with or without an account — may report content that may be illegal or that breaches these Terms or card
              network rules by using the form at{' '}
              <a href="/report" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">prompt-protocol.vercel.app/report</a> or by emailing{' '}
              <a href="mailto:promptandprotocol@gmail.com" className="text-slate-300 hover:text-white underline underline-offset-2 decoration-slate-600">promptandprotocol@gmail.com</a>.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">22.2 Resolution Timeline</h3>
            <p className="mb-4">
              All reported complaints are reviewed and resolved within five (5) business days. Content confirmed to be
              illegal is removed immediately upon identification, and valid requests to remove non-consensual intimate
              imagery are actioned within forty-eight (48) hours.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">22.3 Depicted-Person Appeals</h3>
            <p className="mb-4">
              Any person depicted in content on the Service may appeal for its removal. If the investigation determines that
              consent was not given, has been withdrawn, or is void under applicable law, the content will be removed.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">22.4 Neutral Dispute Resolution</h3>
            <p className="mb-4">
              If a Content Provider disagrees with the outcome of a depicted-person appeal, the disagreement will be referred to
              a neutral third-party body for resolution at our expense.
            </p>

            <h3 className="text-xl font-semibold mb-3 text-slate-300">22.5 Record-Keeping and Processor Reporting</h3>
            <p className="mb-4">
              We maintain records of all complaints, violations, and the actions taken in response, and we report this
              information to our payment processor on a monthly basis as required by card network rules.
            </p>
          </section>

          <div className="mt-12 p-6 border-2 border-white/15 rounded-lg bg-white/[0.03]">
            <p className="font-semibold mb-3 text-lg">By using AI Design Studio, you acknowledge that:</p>
            <ul className="list-disc list-inside space-y-2 ml-4 text-sm">
              <li>You have read, understood, and agree to be bound by these Terms of Service</li>
              <li>You are at least 18 years of age</li>
              <li>If you act as a Content Provider, you agree to the Content Provider Agreement (Section 21)</li>
              <li>You will comply with all applicable laws and third-party provider terms (fal.ai, Google Gemini)</li>
              <li>You understand the limitations and risks of AI-generated content</li>
              <li>You understand that your data may be shared with third-party AI providers</li>
              <li>You accept the disclaimer of warranties and limitation of liability</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
