import {getSupabaseServerClient} from '@/lib/supabase/server';
import {NextResponse} from 'next/server';
import type {EmailOtpType} from '@supabase/supabase-js';
export async function GET(request:Request){const url=new URL(request.url);const token_hash=url.searchParams.get('token_hash');const type=url.searchParams.get('type') as EmailOtpType|null;const client=await getSupabaseServerClient();if(token_hash&&type&&client){const {error}=await client.auth.verifyOtp({token_hash,type});if(!error)return NextResponse.redirect(new URL('/account',url.origin));}return NextResponse.redirect(new URL('/login',url.origin));}
