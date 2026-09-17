import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { expectedSessionValue, safeEqual, SESSION_COOKIE } from '../../../lib/auth';
import { db } from '../../../lib/db';
import { ensureRawItemScoringSchema } from '../../../lib/ai/score-raw-items';

export const dynamic = 'force-dynamic';

async function isAdmin() {
  const store = await cookies();
  const actual = store.get(SESSION_COOKIE)?.value || '';
  const expected = await expectedSessionValue();
  return safeEqual(actual, expected);
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, step: 'auth', message: 'Logg inn i redaksjonspanelet først.' }, { status: 401 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, step: 'env', message: 'DEEPSEEK_API_KEY mangler i denne deploymenten.' }, { status: 500 });
  }

  try {
    const sql = db();
    await ensureRawItemScoringSchema(sql);
    const [row] = await sql`SELECT COUNT(*)::int AS pending FROM raw_items WHERE behandlet = false`;

    const balanceResponse = await fetch('https://api.deepseek.com/user/balance', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const balanceBody = await balanceResponse.json().catch(() => null);
    if (!balanceResponse.ok) {
      return NextResponse.json({
        ok: false,
        step: 'deepseek-balance',
        status: balanceResponse.status,
        message: balanceBody?.error?.message || `DeepSeek svarte HTTP ${balanceResponse.status}`,
        pending: row?.pending ?? null,
      }, { status: 200 });
    }

    if (balanceBody?.is_available === false) {
      return NextResponse.json({
        ok: false,
        step: 'deepseek-balance',
        status: 402,
        message: 'DeepSeek-kontoen har ikke tilgjengelig API-saldo.',
        pending: row?.pending ?? null,
      }, { status: 200 });
    }

    const testResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: 'Svar kun med gyldig JSON.' },
          { role: 'user', content: 'Returner JSON nøyaktig som {"ok":true}.' },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 40,
        stream: false,
      }),
    });
    const testBody = await testResponse.json().catch(() => null);
    if (!testResponse.ok) {
      return NextResponse.json({
        ok: false,
        step: 'deepseek-test-call',
        status: testResponse.status,
        message: testBody?.error?.message || `DeepSeek svarte HTTP ${testResponse.status}`,
        pending: row?.pending ?? null,
      }, { status: 200 });
    }

    return NextResponse.json({
      ok: true,
      database: 'connected',
      deepseek: 'connected',
      balance_available: balanceBody?.is_available !== false,
      pending: row?.pending ?? 0,
      model: testBody?.model || 'deepseek-flash',
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      step: 'server',
      message: error?.message || 'Ukjent serverfeil',
    }, { status: 200 });
  }
}
