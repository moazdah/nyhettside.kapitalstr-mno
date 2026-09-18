import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { ensureRawItemScoringSchema } from '../../../lib/ai/score-raw-items';

export const dynamic = 'force-dynamic';

function deploymentMeta() {
  return {
    vercel_env: process.env.VERCEL_ENV || null,
    git_commit: process.env.VERCEL_GIT_COMMIT_SHA
      ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
      : null,
    deepseek_key_present: Boolean(process.env.DEEPSEEK_API_KEY),
  };
}

export async function GET() {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // TEMPORARY DEVELOPMENT DIAGNOSTIC:
  // Redaksjonspanelet is intentionally open while the site is not live.
  // Never return the secret value itself.
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      step: 'env',
      message: 'DEEPSEEK_API_KEY mangler i denne deploymenten.',
      ...deploymentMeta(),
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const sql = db();
    await ensureRawItemScoringSchema(sql);
    const [row] = await sql`
      SELECT COUNT(*)::int AS pending
      FROM raw_items
      WHERE behandlet = false
    `;

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
        ...deploymentMeta(),
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    if (balanceBody?.is_available === false) {
      return NextResponse.json({
        ok: false,
        step: 'deepseek-balance',
        status: 402,
        message: 'DeepSeek-kontoen har ikke tilgjengelig API-saldo.',
        pending: row?.pending ?? null,
        ...deploymentMeta(),
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
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
        ...deploymentMeta(),
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({
      ok: true,
      database: 'connected',
      deepseek: 'connected',
      balance_available: balanceBody?.is_available !== false,
      pending: row?.pending ?? 0,
      model: testBody?.model || 'deepseek-flash',
      ...deploymentMeta(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      step: 'server',
      message: error?.message || 'Ukjent serverfeil',
      ...deploymentMeta(),
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
}
