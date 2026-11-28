import { getActiveStaff } from '@/lib/supabase/auth';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { loginAction, resetPasswordAction } from '@/app/actions/auth';
import { redirect } from 'next/navigation';
import { ActionForm, Field } from '@/components/action-form';
export default async function Login() {
  if (await getActiveStaff()) redirect('/');
  const configured = await getSupabaseServerClient();
  return (
    <main className="auth">
      <section className="auth-card">
        <div className="brand">
          <span className="brandmark">C</span> Complyete
        </div>
        <h1>Welcome back</h1>
        <p className="muted">Sign in to the ESE staff workspace.</p>
        {configured ? (
          <>
            <ActionForm action={loginAction} label="Sign in">
              <Field name="email" label="Email" type="email" required />
              <Field name="password" label="Password" type="password" required />
            </ActionForm>
            <details className="details">
              <summary>Forgot your password?</summary>
              <ActionForm action={resetPasswordAction} label="Send reset link">
                <Field name="email" label="Email" type="email" required />
              </ActionForm>
            </details>
          </>
        ) : (
          <p className="notice warning">
            The workspace needs Supabase credentials before staff can sign in. Ask your
            administrator to complete setup.
          </p>
        )}
      </section>
    </main>
  );
}
