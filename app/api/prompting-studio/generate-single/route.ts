// app/api/prompting-studio/generate-single/route.ts
// Generates ONE optimized image prompt for a FICTIONAL character or original
// subject. Real, identifiable people are rejected by the content filter before
// any prompt is written — fictional characters (movies, games, anime, books)
// and original creations are allowed.

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { cookies } from 'next/headers';
import { getUserFromSession } from '@/lib/auth';
import { enforceContentFilter } from '@/lib/content-filter';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export async function POST(req: NextRequest) {
  try {
    // This endpoint spends Gemini tokens — signed-in users only
    const token = (await cookies()).get('session')?.value;
    const user = token ? await getUserFromSession(token) : null;
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const body = await req.json();
    // `subject` is the field; `celebrity` accepted as a legacy alias from old clients
    const subject: string = String(body.subject ?? body.celebrity ?? '').trim();
    const { baseStyle, promptModel } = body;

    if (!subject) {
      return NextResponse.json({ error: 'Subject or character name required' }, { status: 400 });
    }

    // Content filter — real people's names are rejected here (fictional
    // characters pass). Same policy as every generation route.
    const cf = await enforceContentFilter(subject, user.email);
    if (!cf.ok) {
      return NextResponse.json({ error: cf.reason }, { status: 400 });
    }

    // Map UI model names to actual Gemini API model names
    const modelNameMap: Record<string, string> = {
      'gemini-3-flash': 'gemini-3-flash-preview',
      'gemini-3-pro': 'gemini-3-pro-preview',
      'gemini-2.0-flash-exp': 'gemini-2.5-flash', // Fallback to stable 2.5
      'gemini-exp-1206': 'gemini-2.5-pro' // Fallback to stable 2.5
    };
    const selectedModel = promptModel || 'gemini-3-flash';
    const actualModelName = modelNameMap[selectedModel] || 'gemini-3-flash-preview';

    const systemPrompt = `You are an expert AI image prompt engineer. Generate ONE optimized prompt for the fictional character or subject "${subject}" with the following requirements:

CRITICAL RULES:
1. The subject must be treated as a FICTIONAL character or original creation — never reference any real person, actor, or celebrity
2. Include high-quality tokens (photorealistic, 4k, high quality, detailed, etc.)
3. Include style: ${baseStyle}
4. Add appropriate lighting, atmosphere, and technical details
5. Keep it under 100 words
6. NO explicit content — focus on artistic/professional qualities

Respond with ONLY the prompt text, no other commentary or formatting.`;

    const aiModel = genAI.getGenerativeModel({
      model: actualModelName,
      generationConfig: { temperature: 0.7 }
    });

    const result = await aiModel.generateContent(systemPrompt);
    const prompt = result.response.text().trim();

    // The generated prompt itself must also pass the filter before it's handed
    // back for one-click generation
    const outCf = await enforceContentFilter(prompt, user.email);
    if (!outCf.ok) {
      return NextResponse.json({ error: outCf.reason }, { status: 400 });
    }

    return NextResponse.json({ success: true, prompt });
  } catch (error) {
    console.error('Prompt generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate prompt' },
      { status: 500 }
    );
  }
}
