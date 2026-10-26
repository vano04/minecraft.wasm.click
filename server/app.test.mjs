import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer as reserveServer, request as httpRequest } from 'node:http';
import { createApp, publicOrigin } from './app.mjs';

const profile={id:'0123456789abcdef0123456789abcdef',name:'FixturePlayer'};
const token='fixture-selected-minecraft-token';
const account=()=>JSON.stringify({type:'MSA',profile,ygg:{token,exp:Math.floor(Date.now()/1000)+3600},
  entitlement:{ownsMinecraft:true,canPlayMinecraft:true}});
const html='<style></style><header>old</header><div class="bar">old</div><script>playButton.onclick = async () => {};installButton.onclick = async () => {};</script>';
async function fixture(run,{fetchImpl=async url=>{
  if(url.endsWith('/entitlements/mcstore'))return Response.json({items:[{name:'game_minecraft'}]});
  if(url.endsWith('/minecraft/profile'))return Response.json(profile);
  throw Error('Unexpected fixture URL');
}}={}) {
  const site=await mkdtemp(join(tmpdir(),'public-launcher-'));
  await mkdir(join(site,'play'));await mkdir(join(site,'privacy'));
  await writeFile(join(site,'play/index.html'),html);await writeFile(join(site,'play/javavm.js'),'runtime fixture');
  await writeFile(join(site,'privacy/index.html'),'<h1>Privacy fixture</h1>');
  await writeFile(join(site,'site.css'),'body { color: black; }');
  await writeFile(join(site,'runtime-files.json'),JSON.stringify({'javavm.js':{},'index.html':{}}));
  await writeFile(join(site,'public-files.json'),JSON.stringify(['site.css','privacy/index.html']));
  const reserve=reserveServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const app=createApp({origin,site,fetchImpl});app.listen(port,'127.0.0.1');await once(app,'listening');
  const request=(path,options={})=>fetch(origin+path,options);
  try {await run({app,request,origin,site});}finally{await app.shutdown();await rm(site,{recursive:true,force:true});}
}

test('public routes render JSON import, keep 404 styling and restrict static files',()=>fixture(async({request,origin})=>{
  const entry=await request('/');assert.equal(entry.status,200);
  const body=await entry.text();assert.match(body,/IMPORT ACCOUNT JSON/);assert.doesNotMatch(body,/microsoft\/start|Unlock testing/);
  assert.equal(entry.headers.get('content-security-policy').includes("script-src 'self'"),true);
  for(const path of ['/privacy','/privacy/'])assert.match(await(await request(path)).text(),/Privacy fixture/);
  for(const path of ['/missing','/.env','/server/json-auth.mjs','/package.json','/play/../../package.json']){
    const response=await request(path);assert.equal(response.status,404,path);assert.match(await response.text(),/Page not found/);
  }
  const head=await request('/missing',{method:'HEAD'});assert.equal(head.status,404);assert.equal(await head.text(),'');
  const wrongHost=await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/',{headers:{Host:'other.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(wrongHost,421);
}));

test('only a verified imported session can load runtime files, and logout revokes it',()=>fixture(async({request,origin})=>{
  assert.equal((await request('/mcweb/auth/session')).status,401);
  assert.equal((await request('/play/javavm.js')).status,401);
  assert.equal((await request('/play/javavm.js',{method:'HEAD'})).status,401);
  const imported=await request('/mcweb/auth/import',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:account()});
  assert.equal(imported.status,200);
  const view=await imported.text();assert.match(view,/FixturePlayer/);assert.ok(!view.includes(token));
  const cookie=imported.headers.get('set-cookie').split(';')[0];
  assert.match(imported.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const asset=await request('/play/javavm.js',{headers:{Cookie:cookie}});
  assert.equal(asset.status,200);assert.equal(await asset.text(),'runtime fixture');
  assert.equal(asset.headers.get('cache-control'),'private, no-store');
  assert.equal(asset.headers.get('cross-origin-opener-policy'),'same-origin');
  const page=await request('/play/',{headers:{Cookie:cookie}});
  assert.equal(page.status,200);const markup=await page.text();assert.match(markup,/FixturePlayer/);assert.ok(!markup.includes(token));
  const entry=await request('/',{headers:{Cookie:cookie},redirect:'manual'});assert.equal(entry.status,303);assert.equal(entry.headers.get('location'),'/play/');
  assert.equal((await request('/mcweb/auth/logout',{method:'POST',headers:{Cookie:cookie}})).status,403);
  assert.equal((await request('/mcweb/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}})).status,200);
  assert.equal((await request('/play/javavm.js',{headers:{Cookie:cookie}})).status,401);
}));

test('import refuses cross-origin requests, wrong content type, excessive input and rejected accounts',()=>fixture(async({request,origin})=>{
  const post=(headers,body=account())=>request('/mcweb/auth/import',{method:'POST',headers,body});
  assert.equal((await post({'Content-Type':'application/json'})).status,403);
  assert.equal((await post({Origin:'https://other.example','Content-Type':'application/json'})).status,403);
  assert.equal((await post({Origin:origin,'Content-Type':'text/plain'})).status,403);
  assert.equal((await post({Origin:origin,'Content-Type':'application/json'},'x'.repeat(1024*1024+1))).status,413);
  const invalid=await post({Origin:origin,'Content-Type':'application/json'},'not json');
  assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes('not json'));
}));

test('public origins require HTTPS and never accept URL credentials or a path',()=>{
  for(const value of ['http://example.com','https://user:password@example.com','https://example.com/path'])assert.throws(()=>publicOrigin(value));
  assert.equal(publicOrigin('https://example.com'),'https://example.com');
  assert.equal(publicOrigin('http://localhost:8080'),'http://localhost:8080');
});

test('staging faults return a generic error without filesystem paths',()=>fixture(async({request,site})=>{
  await rm(join(site,'public-files.json'));
  const response=await request('/site.css');assert.equal(response.status,500);
  const body=await response.text();assert.ok(!body.includes(site));assert.ok(!body.includes('ENOENT'));
  assert.deepEqual(JSON.parse(body),{error:'Request could not be completed.'});
}));
