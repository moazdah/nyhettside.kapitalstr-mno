import Link from 'next/link';
import { loginAction } from './actions';
import AdminSubmitButton from '../AdminSubmitButton';

export default async function RedaksjonLogin({ searchParams }) {
  const params = await searchParams;
  const next = params?.next || '/redaksjon';
  const error = params?.error === '1';
  const config = params?.config === '1';

  return (
    <main className="adminLoginShell">
      <section className="adminLoginCard">
        <Link href="/" className="adminLoginLogo"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /></Link>
        <div className="eyebrow">Redaksjon</div>
        <h1>Logg inn</h1>
        <p>Tilgang til kø, publisering og redaksjonelle kontroller.</p>
        {error && <div className="adminAlert error">Feil passord.</div>}
        {config && <div className="adminAlert error">ADMIN_PASSWORD_HASH mangler i Vercel.</div>}
        <form action={loginAction} className="adminLoginForm">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="password">Passord</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
          <AdminSubmitButton pendingText="Logger inn …">Logg inn</AdminSubmitButton>
        </form>
        <Link href="/" className="adminBackLink">← Tilbake til forsiden</Link>
      </section>
    </main>
  );
}
