import { getSupabaseServerClient } from '@/lib/supabase/server';
import { safeRedirectPath } from '@/lib/env';
import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

const allowedTypes: EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const code = url.searchParams.get('code');
  const client = await getSupabaseServerClient();
  if (client) {
    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(safeRedirectPath(url.searchParams.get('next'), '/account'), url.origin));
    } else if (tokenHash && type && allowedTypes.includes(type as EmailOtpType)) {
      const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
      if (!error) return NextResponse.redirect(new URL(safeRedirectPath(url.searchParams.get('next'), '/account'), url.origin));
    }
  }
  return NextResponse.redirect(new URL('/login', url.origin));
}
