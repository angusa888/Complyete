import { getSupabaseServerClient } from '@/lib/supabase/server';
import { safeRedirectPath } from '@/lib/env';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const client = await getSupabaseServerClient();
  if (code && client) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeRedirectPath(url.searchParams.get('next'), '/account'), url.origin));
  }
  return NextResponse.redirect(new URL('/login', url.origin));
}
