import { safeOperatorRedirect } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">Single-operator workspace</p>
        <h1 id="login-title">Hyperoutreach</h1>
        <p className="muted">
          Sign in with the credentials configured on this installation.
        </p>
        {query.error === "invalid_credentials" ? (
          <p className="alert alert-error" role="alert">
            The email or password is incorrect.
          </p>
        ) : null}
        <form action="/api/operator/session" method="post" className="stack">
          <input type="hidden" name="intent" value="login" />
          <input
            type="hidden"
            name="next"
            value={safeOperatorRedirect(query.next)}
          />
          <label>
            Operator email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={12}
              required
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
