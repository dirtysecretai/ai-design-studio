// app/api/images/by-ids/route.ts
// Fetch multiple images by their IDs (for optimized session loading)

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/auth';
import { checkIsAdmin } from '@/lib/admin-check';
import { jsonPrivate } from '@/lib/api-json'

export async function POST(req: NextRequest) {
  try {
    // This route used to have no auth and no ownership filter, so any caller
    // could post arbitrary ids and read back other people's generations —
    // their URLs, prompts and models. Require a session and scope the lookup
    // to the caller's own rows; admins may look up any.
    const token = (await cookies()).get('session')?.value;
    const user = token ? await getUserFromSession(token) : null;
    if (!user) {
      return jsonPrivate({ error: 'Unauthorized' }, { status: 401 });
    }
    const isAdmin = await checkIsAdmin(user.email);

    const { imageIds } = await req.json();

    if (!Array.isArray(imageIds)) {
      return jsonPrivate(
        { error: 'imageIds must be an array' },
        { status: 400 }
      );
    }

    const ids = imageIds
      .map((n: unknown) => Number(n))
      .filter((n: number) => Number.isInteger(n) && n > 0)
      .slice(0, 500);

    // Fetch images from database
    const images = await prisma.generatedImage.findMany({
      where: {
        id: { in: ids },
        isDeleted: false,
        ...(isAdmin ? {} : { userId: user.id }),
      },
      select: {
        id: true,
        imageUrl: true,
        prompt: true,
        model: true,
        quality: true,
        aspectRatio: true,
        createdAt: true,
      }
    });

    return jsonPrivate({
      success: true,
      images
    });
  } catch (error) {
    console.error('Failed to fetch images by IDs:', error);
    return jsonPrivate(
      { error: 'Failed to fetch images' },
      { status: 500 }
    );
  }
}
