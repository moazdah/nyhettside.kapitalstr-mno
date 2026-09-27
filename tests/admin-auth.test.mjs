import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {expectedSessionValue,passwordMatches,validAdminSession} from '../lib/auth.js';

test('Admin access fails closed and existing password establishes a verifiable session',async()=>{
 const previous=process.env.ADMIN_PASSWORD_HASH;
 try {
  delete process.env.ADMIN_PASSWORD_HASH;
  assert.equal(await validAdminSession('forged'),false);
  process.env.ADMIN_PASSWORD_HASH=createHash('sha256').update('test-only-password').digest('hex');
  assert.equal(await passwordMatches('wrong'),false);
  assert.equal(await passwordMatches('test-only-password'),true);
  assert.equal(await validAdminSession(''),false);
  assert.equal(await validAdminSession('forged'),false);
  const session=await expectedSessionValue();
  assert.equal(await validAdminSession(session),true);
  process.env.ADMIN_PASSWORD_HASH=createHash('sha256').update('replacement-test-password').digest('hex');
  assert.equal(await validAdminSession(session),false);
 } finally {if(previous===undefined) delete process.env.ADMIN_PASSWORD_HASH;else process.env.ADMIN_PASSWORD_HASH=previous;}
});
