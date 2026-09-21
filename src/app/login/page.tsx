import { LoginForm } from '@/components/login-form'

const ERRORS: Record<string, string> = {
  deactivated: 'That account has been deactivated. Ask an owner to re-enable it.',
  forbidden: 'You do not have access to that page.',
  auth: 'That sign-in link was invalid or has expired. Request a new one.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-[--radius] border bg-surface p-6">
        <h1 className="text-lg font-semibold tracking-tight">Upwork Agency Portal</h1>
        <p className="mt-1 text-sm text-soft">
          Sign in with your work email. The conversations you have been given access to are
          waiting — no Upwork login of your own needed.
        </p>

        {error && ERRORS[error] && (
          <p className="mt-4 rounded-[--radius-sm] bg-stop/10 px-3 py-2 text-sm text-stop">
            {ERRORS[error]}
          </p>
        )}

        <LoginForm next={next} />
      </div>
    </div>
  )
}
