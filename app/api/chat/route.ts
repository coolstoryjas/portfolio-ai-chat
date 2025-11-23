// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';

// Optional, but fine with App Router
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // ignore if no JSON body
  }

  return NextResponse.json({
    ok: true,
    message: 'Chat endpoint is alive.',
    received: body,
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Chat endpoint is reachable via GET.',
  });
}
