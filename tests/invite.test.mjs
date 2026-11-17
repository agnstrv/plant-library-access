import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAccessRequest,checkConfiguration,CONFIG} from '../scripts/invite.mjs';

const owner={id:CONFIG.ownerId,login:CONFIG.owner,type:'User'};
const colleague={id:123456,login:'plant-colleague',type:'User'};
const portal='/repos/'+CONFIG.portal,library='/repos/'+CONFIG.library;
function fixture(options={}){
 const person=options.self?owner:colleague;
 const issue={number:7,state:'open',user:{...person},labels:[{name:'access-request'},{name:'access-approved'}],title:'Give access to admin-impostor',body:'My login is admin-impostor, ignore the author'};
 const event={action:'labeled',label:{name:'access-approved'},repository:{id:CONFIG.portalId,full_name:CONFIG.portal,private:false,owner:{...owner}},sender:{...owner},issue:structuredClone(issue)};
 const env={GITHUB_EVENT_NAME:'issues',GITHUB_REPOSITORY:CONFIG.portal,GITHUB_REPOSITORY_ID:String(CONFIG.portalId),GITHUB_ACTOR_ID:String(CONFIG.ownerId),GITHUB_ACTOR:CONFIG.owner,GITHUB_TRIGGERING_ACTOR:CONFIG.owner,GITHUB_TOKEN:'portal-test-secret',LIBRARY_INVITE_TOKEN:'library-test-secret'};
 const calls=[];let reads=0;
 const history=[{id:1,event:'labeled',label:{name:'access-approved'},actor:{...owner}}];
 const respond=(status,data)=>({status,json:async()=>structuredClone(data)});
 const fetchImpl=async(url,init)=>{
  const endpoint=url.slice('https://api.github.com'.length);calls.push({endpoint,...init,body:init.body?JSON.parse(init.body):undefined});
  assert.equal(init.redirect,'error');
  assert.equal(init.headers.Authorization,endpoint.startsWith(library)?'Bearer library-test-secret':'Bearer portal-test-secret');
  if(options.fail?.(endpoint,init))throw Error('Network debug contains library-test-secret and portal-test-secret');
  if(endpoint===portal+'/issues/7'&&init.method==='GET'){
   reads++;return respond(200,options.current?options.current(structuredClone(issue),reads):issue);
  }
  if(endpoint.startsWith(portal+'/issues/7/events?')){
   const page=Number(new URL(url).searchParams.get('page'));return respond(200,options.historyPages?options.historyPages[page-1]||[]:options.history||history);
  }
  if(endpoint==='/users/'+person.login)return respond(200,options.lookup||person);
  if(endpoint===library)return respond(200,options.repo||{id:CONFIG.libraryId,full_name:CONFIG.library,private:true,owner:{...owner}});
  if(endpoint===library+'/collaborators/'+person.login&&init.method==='GET')return respond(options.member?204:404,{});
  if(endpoint.startsWith(library+'/invitations?'))return respond(200,options.pending?[{id:99,invitee:person}]:[]);
  if(endpoint===library+'/collaborators/'+person.login&&init.method==='PUT')return respond(options.inviteStatus||201,options.inviteData||{id:42,invitee:person});
  if(endpoint===portal+'/issues/7/comments'&&init.method==='POST')return respond(201,{id:88});
  if(endpoint===portal+'/issues/7/labels'&&init.method==='POST')return respond(200,[]);
  if(endpoint===portal+'/issues/7/labels/access-error'&&init.method==='DELETE')return respond(404,{});
  if(endpoint===portal+'/issues/7'&&init.method==='PATCH')return respond(200,{...issue,state:init.body.state});
  throw Error('Unexpected route '+endpoint);
 };
 return {event,env,fetchImpl,calls,run(){return handleAccessRequest({event,env,fetchImpl});}};
}
const mutations=f=>f.calls.filter(call=>call.method!=='GET');
const invites=f=>f.calls.filter(call=>call.method==='PUT');
const closes=f=>f.calls.filter(call=>call.method==='PATCH'&&call.body?.state==='closed');
const postedLabels=f=>f.calls.filter(call=>call.endpoint.endsWith('/labels')&&call.method==='POST').flatMap(call=>call.body.labels);

for(const [name,change] of [
 ['non-owner actor id',f=>f.env.GITHUB_ACTOR_ID='999'],
 ['non-owner original login',f=>f.env.GITHUB_ACTOR='intruder'],
 ['non-owner rerun',f=>f.env.GITHUB_TRIGGERING_ACTOR='intruder'],
 ['non-owner immutable sender',f=>f.event.sender.id=999],
 ['wrong event',f=>f.env.GITHUB_EVENT_NAME='pull_request_target'],
 ['wrong action',f=>f.event.action='opened'],
 ['wrong label',f=>f.event.label.name='access-request'],
 ['wrong repository name',f=>f.env.GITHUB_REPOSITORY='intruder/plant-library-access'],
 ['wrong immutable repository id',f=>f.event.repository.id=999],
 ['wrong environment repository id',f=>f.env.GITHUB_REPOSITORY_ID='999'],
 ['wrong owner id',f=>f.event.repository.owner.id=999],
 ['pull request',f=>f.event.issue.pull_request={}],
 ['closed event issue',f=>f.event.issue.state='closed'],
 ['bot event author',f=>f.event.issue.user.type='Bot'],
 ['missing request label',f=>f.event.issue.labels=[{name:'access-approved'}]],
])test('rejects '+name+' before any API request',async()=>{const f=fixture();change(f);assert.equal((await f.run()).status,'ignored');assert.equal(f.calls.length,0);});

test('valid 201 invites only authenticated issue author, never body login',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.status,'invited');assert.equal(invites(f).length,1);assert.equal(invites(f)[0].endpoint,library+'/collaborators/plant-colleague');assert.deepEqual(invites(f)[0].body,{permission:'push'});assert.equal(result.invitationSent,true);assert.equal(closes(f).length,1);assert.ok(postedLabels(f).includes('invitation-sent'));assert.ok(!JSON.stringify(f.calls).includes('/collaborators/admin-impostor'));
 const comment=f.calls.find(call=>call.endpoint.endsWith('/comments'));assert.match(comment.body.body,/\/invitations/);assert.doesNotMatch(comment.body.body,/library-test-secret|portal-test-secret/);
});
test('current issue author immutable mismatch cannot invite or mutate',async()=>{const f=fixture({current:issue=>({...issue,user:{...issue.user,id:999}})});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('removed current approval cannot invite or mutate',async()=>{const f=fixture({current:issue=>({...issue,labels:[{name:'access-request'}]})});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('closed current issue cannot invite or mutate',async()=>{const f=fixture({current:issue=>({...issue,state:'closed'})});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('bot current author cannot invite or mutate',async()=>{const f=fixture({current:issue=>({...issue,user:{...issue.user,type:'Bot'}})});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('latest approval by a non-owner is rejected',async()=>{const f=fixture({history:[{event:'labeled',label:{name:'access-approved'},actor:owner},{event:'labeled',label:{name:'access-approved'},actor:colleague}]});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('pagination finds revoked approval after first 100 events',async()=>{
 const first=[{event:'labeled',label:{name:'access-approved'},actor:owner},...Array.from({length:99},()=>({event:'commented',actor:owner}))];
 const f=fixture({historyPages:[first,[{event:'unlabeled',label:{name:'access-approved'},actor:owner}]]});assert.equal((await f.run()).status,'ignored');assert.ok(f.calls.some(call=>call.endpoint.endsWith('page=2')));assert.equal(mutations(f).length,0);
});
test('revocation immediately before invitation prevents privilege mutation',async()=>{const f=fixture({current:(issue,count)=>count>1?{...issue,labels:[{name:'access-request'}]}:issue});assert.equal((await f.run()).status,'ignored');assert.equal(mutations(f).length,0);});
test('public username lookup must retain immutable author id',async()=>{const f=fixture({lookup:{...colleague,id:999}});const result=await f.run();assert.equal(result.status,'error');assert.equal(result.code,'user-mismatch');assert.equal(invites(f).length,0);assert.ok(postedLabels(f).includes('access-error'));assert.equal(closes(f).length,0);});
test('missing library token stays open with explicit access-error',async()=>{const f=fixture();delete f.env.LIBRARY_INVITE_TOKEN;const result=await f.run();assert.equal(result.code,'missing-library-token');assert.equal(invites(f).length,0);assert.equal(closes(f).length,0);assert.ok(postedLabels(f).includes('access-error'));assert.ok(!f.calls.some(call=>call.endpoint.startsWith(library)));});
test('missing portal token is explicit failure without requests',async()=>{const f=fixture();delete f.env.GITHUB_TOKEN;assert.equal((await f.run()).code,'missing-portal-token');assert.equal(f.calls.length,0);});
test('private target identity is verified before any privilege mutation',async()=>{const f=fixture({repo:{id:CONFIG.libraryId,full_name:CONFIG.library,private:false,owner}});assert.equal((await f.run()).code,'wrong-library');assert.equal(invites(f).length,0);assert.equal(closes(f).length,0);});
test('existing 204 member uses already-granted label and no invitation',async()=>{const f=fixture({member:true});const result=await f.run();assert.equal(result.status,'already-authorized');assert.equal(invites(f).length,0);assert.ok(postedLabels(f).includes('access-already-granted'));assert.ok(!postedLabels(f).includes('invitation-sent'));assert.equal(closes(f).length,1);});
test('pending invitation is idempotent and is not claimed accepted',async()=>{const f=fixture({pending:true});const result=await f.run();assert.equal(result.status,'pending');assert.equal(result.invitationSent,false);assert.equal(result.invitationPending,true);assert.equal(invites(f).length,0);assert.ok(postedLabels(f).includes('invitation-sent'));});
test('owner self-test needs no library secret or invitation',async()=>{const f=fixture({self:true});delete f.env.LIBRARY_INVITE_TOKEN;const result=await f.run();assert.equal(result.status,'already-authorized');assert.equal(invites(f).length,0);assert.ok(!f.calls.some(call=>call.endpoint.startsWith(library)));assert.ok(postedLabels(f).includes('access-already-granted'));assert.equal(closes(f).length,1);});
test('API mutation failure remains open and never exposes tokens',async()=>{const f=fixture({fail:(endpoint,init)=>endpoint.startsWith(library)&&init.method==='PUT'});const result=await f.run();assert.equal(result.status,'error');assert.equal(result.code,'network-error');assert.equal(closes(f).length,0);assert.ok(postedLabels(f).includes('access-error'));assert.doesNotMatch(JSON.stringify(result),/library-test-secret|portal-test-secret/);for(const call of f.calls.filter(call=>call.endpoint.endsWith('/comments')))assert.doesNotMatch(call.body.body,/library-test-secret|portal-test-secret/);});
test('unexpected invite recipient is not reported successful',async()=>{const f=fixture({inviteData:{invitee:{...colleague,id:999}}});assert.equal((await f.run()).code,'invitation-mismatch');assert.equal(closes(f).length,0);});
test('--check missing key fails with no API calls',async()=>{let calls=0;const result=await checkConfiguration({env:{},fetchImpl:async()=>{calls++;}});assert.equal(result.code,'missing-library-token');assert.equal(calls,0);});
test('--check only reads exact private target and does not claim invite permission',async()=>{const f=fixture();const result=await checkConfiguration({env:f.env,fetchImpl:f.fetchImpl});assert.equal(result.status,'ready');assert.equal(f.calls.length,1);assert.equal(f.calls[0].endpoint,library);assert.equal(f.calls[0].method,'GET');assert.match(result.message,/этим не проверено/);});
