import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { enqueue,claim,checkpoint,fail } from '../lib/engine/jobs.mjs';
export async function engineChecks(sql,other=sql) {
  const kind=`test-${randomUUID()}`;
  try {
    const a=await enqueue(sql,kind,'slot-a');
    const duplicate=await enqueue(other,kind,'slot-a');
    assert.equal(String(a.id),String(duplicate.id));
    const b=await enqueue(sql,kind,'slot-b');
    const claims=await Promise.all([claim(sql,a.id),claim(other,a.id)]);
    assert.equal(claims.filter(Boolean).length,1);
    const first=claims.find(Boolean);
    assert.equal(await claim(other,b.id),null,'same kind must not overlap');
    await sql`UPDATE engine_jobs SET lease_until=now()-interval '1 second' WHERE id=${Number(a.id)}`;
    const resumed=await claim(other,a.id);
    assert.ok(resumed);
    await assert.rejects(checkpoint(sql,first,{bad:true},{done:true}),/ENGINE_LEASE_LOST/);
    await checkpoint(other,resumed,{stage:'publish',runId:42});
    const [saved]=await sql`SELECT * FROM engine_jobs WHERE id=${Number(a.id)}`;
    assert.equal(saved.payload.stage,'publish');
    assert.equal(saved.status,'pending');
    const next=await claim(sql,a.id);
    await fail(sql,next,new Error('simulated interruption'));
    assert.equal(await claim(other,a.id),null,'retry delay respected');
    await sql`UPDATE engine_jobs SET retry_after=now()-interval '1 second' WHERE id=${Number(a.id)}`;
    const retry=await claim(other,a.id);
    assert.equal(retry.payload.runId,42);
    await checkpoint(other,retry,{stage:'done',runId:42},{done:true});
    assert.equal(await claim(sql,a.id),null,'completion is durable');
    await assert.rejects(fail(sql,retry,new Error('lost response')),/ENGINE_LEASE_LOST/);
    const second=await claim(sql,b.id);
    await sql`UPDATE engine_jobs SET attempts=5,lease_until=now()-interval '1 second' WHERE id=${Number(b.id)}`;
    assert.equal(await claim(other,b.id),null);
    const [exhausted]=await sql`SELECT status FROM engine_jobs WHERE id=${Number(b.id)}`;
    assert.equal(exhausted.status,'failed');
    assert.ok(second);
  } finally { await sql`DELETE FROM engine_jobs WHERE kind=${kind}`; }
}
