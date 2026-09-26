import { db } from '../db';
import { ensureEditorialSelectionSchema } from '../autopilot/editorial-selection';
import { runAutopilotStep } from '../autopilot/autopilot';
import { enqueue, claim, checkpoint, fail, nextJob } from './jobs.mjs';
import { activeHours, slot } from './clock.mjs';
export async function runEditorialJob({runId=null,scheduledSlot=null} = {}) {
  const sql = db();
  await ensureEditorialSelectionSchema(sql);
  let pending;
  if (runId) {
    const [run]=await sql`SELECT scheduled_slot FROM editorial_runs WHERE id=${Number(runId)} AND mode='scheduled'`;
    if (!run) throw new Error('SCHEDULED_RUN_NOT_FOUND');
    pending=await enqueue(sql,'editorial',run.scheduled_slot || `run-${runId}`,{runId:Number(runId)});
  } else pending=await nextJob(sql,'editorial');
  if (!pending && activeHours()) pending=await enqueue(sql,'editorial',scheduledSlot || slot(new Date(),60));
  if (!pending) return {ok:true,skipped:true};
  const job=await claim(sql,pending.id);
  if (!job) return {ok:true,skipped:!runId,runId,stage:pending.status==='done'?'done':'waiting',state:{retryAfterSeconds:15},reason:'busy_or_retry_wait'};
  try {
    const result=await runAutopilotStep({runId:job.payload.runId||null,discovery:!job.payload.runId,mode:'scheduled',scheduledSlot:job.slot});
    await checkpoint(sql,job,{runId:result.runId,lastErrors:result.errors||[]},{done:result.stage==='done',delay:result.stage==='waiting'?15:0,errorMessage:result.errors?.join(' | ').slice(0,800)||null});
    return result;
  } catch(error) { await fail(sql,job,error); throw error; }
}
