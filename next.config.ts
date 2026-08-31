import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },

  // ffmpeg-static resolves its binary relative to its own __dirname — bundling
  // it breaks that path, so it must stay external; tracing then carries the
  // binary for the reference-video trim route on Vercel
  serverExternalPackages: ['ffmpeg-static'],
  // Pin the workspace root: a stray lockfile in a parent directory made Next
  // infer the wrong root (build warning), which fed the runaway tracing below.
  turbopack: {
    root: __dirname,
  },
  outputFileTracingIncludes: {
    '/api/user/references/trim-video': ['./node_modules/ffmpeg-static/**'],
    '/api/admin/frames-gif': ['./node_modules/ffmpeg-static/**'],
    '/api/admin/frames-clips': ['./node_modules/ffmpeg-static/**'],
    '/api/video/assemble': ['./node_modules/ffmpeg-static/**'],
    '/api/admin/dataset/thumb/[id]': ['./node_modules/ffmpeg-static/**'],
    '/api/admin/dataset/preview/[id]': ['./node_modules/ffmpeg-static/**'],
  },
  // Routes importing lib/video-clip get their trace exploded to the ENTIRE
  // project dir (AI/ training junk, .git, uploads — 14GB locally, 401MB of
  // committed files on Vercel, over the 250MB function limit and failing every
  // deploy). ffmpeg-static itself is traced automatically via its import; these
  // excludes just keep the junk out of every function bundle.
  outputFileTracingExcludes: {
    '*': ['AI/**', '.git/**', 'public/uploads/**', 'Wan2.2/**', '**/*.pth', '**/*.safetensors'],
  },

  images: {
    remotePatterns: [
      { hostname: 'pub-de315f4652054008be5f90bf09919f80.r2.dev' },
      { hostname: 'fal.media' },
      { hostname: '*.fal.media' },
      { hostname: 'storage.googleapis.com' },
      { hostname: 'replicate.delivery' },
      { hostname: 'blob.vercel-storage.com' },
      { hostname: '*.r2.cloudflarestorage.com' },
      { hostname: '1a011a0b69a1fdbbc132a89b181d2f80.r2.cloudflarestorage.com' },
    ],
  },
};

export default nextConfig;
