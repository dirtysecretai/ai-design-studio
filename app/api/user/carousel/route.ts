import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/auth';
import { cookies } from 'next/headers';
import { uploadToR2, uploadPublicAsset } from '@/lib/r2';


const MAX_IMAGES_PER_SIDE = 5;

// GET - Get user's carousel images
export async function GET(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const carouselImages = await prisma.carouselImage.findMany({
      where: {
        userId: user.id,
        isActive: true
      },
      orderBy: {
        position: 'asc'
      }
    });

    // Count per side
    const leftCount = carouselImages.filter(c => c.side === 'left').length;
    const rightCount = carouselImages.filter(c => c.side === 'right').length;

    return NextResponse.json({
      success: true,
      images: carouselImages,
      counts: {
        left: leftCount,
        right: rightCount,
        maxPerSide: MAX_IMAGES_PER_SIDE
      }
    });

  } catch (error: any) {
    console.error('Error fetching carousel:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch carousel images' },
      { status: 500 }
    );
  }
}

// POST - Upload new carousel image
export async function POST(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('image') as File;
    const side = formData.get('side') as string;
    const position = parseInt(formData.get('position') as string) || 0;

    if (!file || !side) {
      return NextResponse.json(
        { error: 'Image file and side are required' },
        { status: 400 }
      );
    }

    if (side !== 'left' && side !== 'right') {
      return NextResponse.json(
        { error: 'Side must be "left" or "right"' },
        { status: 400 }
      );
    }

    // Check limit for this side
    const existingCount = await prisma.carouselImage.count({
      where: {
        userId: user.id,
        side: side,
        isActive: true
      }
    });

    if (existingCount >= MAX_IMAGES_PER_SIDE) {
      return NextResponse.json(
        { error: `Maximum ${MAX_IMAGES_PER_SIDE} images allowed per side. Delete some images first.` },
        { status: 400 }
      );
    }

    // Upload to R2
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const url = await uploadPublicAsset(`carousel/${user.id}/${side}-${Date.now()}.${file.name.split('.').pop()}`, fileBuffer, file.type);

    // Create carousel image record
    const carouselImage = await prisma.carouselImage.create({
      data: {
        userId: user.id,
        imageUrl: url,
        side: side,
        position: position,
        isActive: true
      }
    });

    console.log(`✅ Carousel image uploaded: User ${user.id}, ${side} side`);

    return NextResponse.json({
      success: true,
      image: carouselImage
    });

  } catch (error: any) {
    console.error('Error uploading carousel image:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to upload image' },
      { status: 500 }
    );
  }
}

// PUT - Update carousel image position
export async function PUT(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { id, position } = body;

    if (!id) {
      return NextResponse.json(
        { error: 'Image id is required' },
        { status: 400 }
      );
    }

    // Verify ownership
    const existing = await prisma.carouselImage.findFirst({
      where: {
        id: parseInt(id),
        userId: user.id
      }
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Image not found or not owned by you' },
        { status: 404 }
      );
    }

    const updated = await prisma.carouselImage.update({
      where: { id: parseInt(id) },
      data: { position: parseInt(position) }
    });

    return NextResponse.json({
      success: true,
      image: updated
    });

  } catch (error: any) {
    console.error('Error updating carousel image:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update image' },
      { status: 500 }
    );
  }
}

// DELETE - Remove carousel image
export async function DELETE(req: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return NextResponse.json(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'Image id is required' },
        { status: 400 }
      );
    }

    // Verify ownership
    const existing = await prisma.carouselImage.findFirst({
      where: {
        id: parseInt(id),
        userId: user.id
      }
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Image not found or not owned by you' },
        { status: 404 }
      );
    }

    await prisma.carouselImage.delete({
      where: { id: parseInt(id) }
    });

    console.log(`✅ Carousel image deleted: User ${user.id}, ID ${id}`);

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Error deleting carousel image:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to delete image' },
      { status: 500 }
    );
  }
}
