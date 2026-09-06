// app/api/upload-reference/route.ts
// Accepts a single reference image as FormData and stores it in R2.
// Full-quality originals (jpeg/png/webp ≤10MB) arrive untouched; larger or
// exotic formats are re-encoded to a 4096px JPEG client-side first.

import { uploadToR2, userKey } from '@/lib/r2';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getUserFromSession } from '@/lib/auth';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB — client compresses to ≤1920px

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // Require a valid session — previously any anonymous caller could upload to R2.
    const token = (await cookies()).get('session')?.value;
    const sessionUser = token ? await getUserFromSession(token) : null;
    if (!sessionUser) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'File too large (max 15MB)' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Preserve the original format — the client now uploads full-quality originals
    // (jpeg/png/webp) untouched; anything else was re-encoded to JPEG client-side.
    const type = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    const filename = `reference-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;

    const url = await uploadToR2(userKey(sessionUser.id, filename), buffer, type);

    return NextResponse.json({ url });
  } catch (error) {
    console.error('Reference upload error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
