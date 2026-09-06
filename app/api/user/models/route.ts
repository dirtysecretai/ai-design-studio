import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/auth';
import { cookies } from 'next/headers';
import { jsonPrivate } from '@/lib/api-json'


// GET - Fetch all user models
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return jsonPrivate(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return jsonPrivate(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const models = await prisma.userModel.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    });

    return jsonPrivate({
      success: true,
      models
    });
  } catch (error: any) {
    console.error('Error fetching user models:', error);
    return jsonPrivate(
      { error: 'Failed to fetch models' },
      { status: 500 }
    );
  }
}

// POST - Create a new user model
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return jsonPrivate(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return jsonPrivate(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const { name, referenceImageUrls } = await request.json();

    // Validation
    if (!name || !name.trim()) {
      return jsonPrivate(
        { error: 'Model name is required' },
        { status: 400 }
      );
    }

    if (!Array.isArray(referenceImageUrls) || referenceImageUrls.length === 0) {
      return jsonPrivate(
        { error: 'At least one reference image is required' },
        { status: 400 }
      );
    }

    if (referenceImageUrls.length > 8) {
      return jsonPrivate(
        { error: 'Maximum 8 reference images allowed' },
        { status: 400 }
      );
    }

    // Create model
    const newModel = await prisma.userModel.create({
      data: {
        userId: user.id,
        name: name.trim(),
        referenceImageUrls
      }
    });

    return jsonPrivate({
      success: true,
      model: newModel
    });
  } catch (error: any) {
    console.error('Error creating user model:', error);
    return jsonPrivate(
      { error: 'Failed to create model' },
      { status: 500 }
    );
  }
}

// DELETE - Delete a user model
export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('session')?.value;

    if (!token) {
      return jsonPrivate(
        { error: 'Not authenticated' },
        { status: 401 }
      );
    }

    const user = await getUserFromSession(token);
    if (!user) {
      return jsonPrivate(
        { error: 'Invalid session' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('id');

    if (!modelId) {
      return jsonPrivate(
        { error: 'Model ID is required' },
        { status: 400 }
      );
    }

    // Check if model exists and belongs to user
    const model = await prisma.userModel.findFirst({
      where: {
        id: parseInt(modelId),
        userId: user.id
      }
    });

    if (!model) {
      return jsonPrivate(
        { error: 'Model not found' },
        { status: 404 }
      );
    }

    // Delete model
    await prisma.userModel.delete({
      where: { id: parseInt(modelId) }
    });

    return jsonPrivate({
      success: true,
      message: 'Model deleted successfully'
    });
  } catch (error: any) {
    console.error('Error deleting user model:', error);
    return jsonPrivate(
      { error: 'Failed to delete model' },
      { status: 500 }
    );
  }
}
