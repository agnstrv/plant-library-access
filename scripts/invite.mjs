import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const CONFIG = Object.freeze({
 portal:'agnstrv/plant-library-access', portalId:1461140644,
 library:'agnstrv/plant-texture-library', libraryId:1461061556,
 owner:'agnstrv', ownerId:148447292,
 requestLabel:'access-request', approvedLabel:'access-approved',
 sentLabel:'invitation-sent', existingLabel:'access-already-granted', errorLabel:'access-error',
});
const API='https://api.github.com';
const inviteLink='https://github.com/'+CONFIG.library+'/invitations';
class AccessError extends Error {
 constructor(code,message){super(message);this.name='AccessError';this.code=code;}
}
function failure(code,message){throw new AccessError(code,message);}
function safeError(error){return error instanceof AccessError ? {code:error.code,message:error.message} : {code:'unexpected-error',message:'Внутренняя ошибка. Приглашение не подтверждено; проверьте запуск и повторите одобрение.'};}
const isOwner=user=>user?.id===CONFIG.ownerId&&user?.login===CONFIG.owner;
const isPerson=user=>Number.isSafeInteger(user?.id)&&user.id>0&&user.type==='User'&&typeof user.login==='string'&&/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(user.login)&&!user.login.endsWith('[bot]');
const labels=issue=>new Set((issue.labels||[]).map(label=>typeof label==='string'?label:label?.name));
const portalPath='/repos/'+CONFIG.portal;
const libraryPath='/repos/'+CONFIG.library;

function eventAllowed(event,env){
 return env.GITHUB_EVENT_NAME==='issues'&&event?.action==='labeled'&&event.label?.name===CONFIG.approvedLabel
  &&env.GITHUB_REPOSITORY===CONFIG.portal&&String(env.GITHUB_REPOSITORY_ID)===String(CONFIG.portalId)
  &&String(env.GITHUB_ACTOR_ID)===String(CONFIG.ownerId)&&env.GITHUB_ACTOR===CONFIG.owner&&env.GITHUB_TRIGGERING_ACTOR===CONFIG.owner
  &&event.repository?.id===CONFIG.portalId&&event.repository.full_name===CONFIG.portal&&event.repository.private===false
  &&isOwner(event.repository.owner)&&isOwner(event.sender)
  &&Number.isSafeInteger(event.issue?.number)&&event.issue.number>0&&!event.issue.pull_request
  &&event.issue.state==='open'&&isPerson(event.issue.user)
  &&labels(event.issue).has(CONFIG.requestLabel)&&labels(event.issue).has(CONFIG.approvedLabel);
}
function client(fetchImpl,token,scope){
 return async function request(endpoint,{method='GET',body,expected=[200]}={}){
  const valid=scope==='library'
   ? endpoint===libraryPath||endpoint.startsWith(libraryPath+'/')
   : endpoint.startsWith(portalPath+'/issues/')||/^\/users\/[a-zA-Z0-9-]+$/.test(endpoint);
  if(!valid||/[\r\n#]/.test(endpoint))failure('endpoint-rejected','Запрос к неподтверждённому API заблокирован.');
  let response;
  try {
   response=await fetchImpl(API+endpoint,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  } catch {failure('network-error','GitHub недоступен или отклонил безопасное соединение. Приглашение не подтверждено.');}
  if(!expected.includes(response.status))failure('github-api-error','GitHub отклонил операцию (HTTP '+Number(response.status)+'). Проверьте права и повторите запуск.');
  let data=null;
  if(response.status!==204){try{data=await response.json();}catch{failure('invalid-api-response','GitHub вернул некорректный ответ. Приглашение не подтверждено.');}}
  return {status:response.status,data};
 };
}
async function pages(api,endpoint){
 const items=[];
 for(let page=1;page<=100;page++){
  const {data}=await api(endpoint+'?per_page=100&page='+page);
  if(!Array.isArray(data))failure('invalid-api-response','GitHub вернул некорректный список.');
  items.push(...data);
  if(data.length<100)return items;
 }
 failure('pagination-limit','Слишком большая история заявки. Требуется ручная проверка владельцем.');
}
async function currentApproval(api,number,expectedUserId){
 const {data:issue}=await api(portalPath+'/issues/'+number);
 if(issue?.number!==number||issue.pull_request||issue.state!=='open'||!isPerson(issue.user)||issue.user.id!==expectedUserId)return null;
 const currentLabels=labels(issue);
 if(!currentLabels.has(CONFIG.requestLabel)||!currentLabels.has(CONFIG.approvedLabel))return null;
 const events=await pages(api,portalPath+'/issues/'+number+'/events');
 const last=events.filter(entry=>(entry.event==='labeled'||entry.event==='unlabeled')&&entry.label?.name===CONFIG.approvedLabel).at(-1);
 if(last?.event!=='labeled'||!isOwner(last.actor))return null;
 return issue;
}
async function verifyLibrary(api){
 const {data}=await api(libraryPath);
 if(data?.id!==CONFIG.libraryId||data.full_name!==CONFIG.library||data.private!==true||!isOwner(data.owner))failure('wrong-library','Целевой репозиторий не совпадает с утверждённой закрытой библиотекой. Операция остановлена.');
 return data;
}
export async function checkConfiguration({env=process.env,fetchImpl=fetch}={}){
 if(!env.LIBRARY_INVITE_TOKEN)return {status:'error',code:'missing-library-token',message:'Секрет LIBRARY_INVITE_TOKEN не настроен. Приглашения пока не работают.'};
 try{await verifyLibrary(client(fetchImpl,env.LIBRARY_INVITE_TOKEN,'library'));return {status:'ready',message:'Токен видит утверждённую закрытую библиотеку. Приглашения не отправлялись; право выдачи приглашений этим не проверено.'};}
 catch(error){return {status:'error',...safeError(error)};}
}
async function markSuccess(api,number,kind){
 const message=kind==='already-authorized'
  ? 'Доступ к закрытой библиотеке у вашего аккаунта уже есть. Новое приглашение не создавалось. Откройте https://github.com/'+CONFIG.library+' под своим GitHub-аккаунтом.'
  : 'Приглашение в закрытую библиотеку '+(kind==='pending'?'уже ожидает принятия':'создано')+'. Откройте '+inviteLink+' под тем GitHub-аккаунтом, с которого создана эта заявка, и примите приглашение. Затем попросите Codex открыть библиотеку. Метка invitation-sent означает отправленное приглашение, а не подтверждённое принятие.';
 await api(portalPath+'/issues/'+number+'/comments',{method:'POST',body:{body:message},expected:[201]});
 await api(portalPath+'/issues/'+number+'/labels',{method:'POST',body:{labels:[kind==='already-authorized'?CONFIG.existingLabel:CONFIG.sentLabel]},expected:[200]});
 await api(portalPath+'/issues/'+number+'/labels/'+CONFIG.errorLabel,{method:'DELETE',expected:[200,204,404]});
 await api(portalPath+'/issues/'+number,{method:'PATCH',body:{state:'closed'},expected:[200]});
}
async function markFailure(api,number,error){
 await api(portalPath+'/issues/'+number+'/labels',{method:'POST',body:{labels:[CONFIG.errorLabel]},expected:[200]});
 await api(portalPath+'/issues/'+number+'/comments',{method:'POST',body:{body:'Автоматическая выдача доступа не завершена. '+error.message+' Успешная выдача доступа не подтверждена. Заявка остаётся открытой; владелец может исправить настройку и повторить запуск.'},expected:[201]});
}
export async function handleAccessRequest({event,env=process.env,fetchImpl=fetch}={}){
 if(!eventAllowed(event,env))return {status:'ignored',reason:'Событие не является одобрением владельца для утверждённого портала.'};
 const portalToken=env.PORTAL_TOKEN||env.GITHUB_TOKEN;
 if(!portalToken)return {status:'error',code:'missing-portal-token',message:'Не настроен токен портала. Приглашения не отправлялись.'};
 const portal=client(fetchImpl,portalToken,'portal'), number=event.issue.number, expectedUserId=event.issue.user.id;
 let approved=false;
 try {
  let issue=await currentApproval(portal,number,expectedUserId);
  if(!issue)return {status:'ignored',reason:'Заявка изменилась, закрыта или актуальное одобрение владельца отсутствует.'};
  approved=true;
  const {data:user}=await portal('/users/'+encodeURIComponent(issue.user.login));
  if(!isPerson(user)||user.id!==expectedUserId||user.login!==issue.user.login)failure('user-mismatch','GitHub-аккаунт автора не удалось подтвердить. Приглашение не отправлено.');
  let kind='already-authorized';
  if(!isOwner(user)){
   if(!env.LIBRARY_INVITE_TOKEN)failure('missing-library-token','Секрет LIBRARY_INVITE_TOKEN не настроен. Выдача приглашений ожидает настройки владельцем.');
   const library=client(fetchImpl,env.LIBRARY_INVITE_TOKEN,'library');
   await verifyLibrary(library);
   const membership=await library(libraryPath+'/collaborators/'+encodeURIComponent(user.login),{expected:[204,404]});
   if(membership.status===404){
    const invitations=await pages(library,libraryPath+'/invitations');
    if(invitations.some(invitation=>invitation.invitee?.id===expectedUserId))kind='pending';
    else {
     // Re-read approval immediately before the privilege-changing request, including after a workflow rerun.
     issue=await currentApproval(portal,number,expectedUserId);
     if(!issue||issue.user.login!==user.login)return {status:'ignored',reason:'Одобрение отозвано или аккаунт изменился перед выдачей приглашения.'};
     const invitation=await library(libraryPath+'/collaborators/'+encodeURIComponent(user.login),{method:'PUT',body:{permission:'push'},expected:[201,204]});
     if(invitation.status===201){
      if(invitation.data?.invitee?.id!==expectedUserId)failure('invitation-mismatch','Ответ GitHub не подтвердил ожидаемого получателя приглашения. Требуется проверка владельцем.');
      kind='invited';
     }
    }
   }
  }
  // Revalidate before closing/commenting, so a revoked approval is not reported as current success.
  if(!await currentApproval(portal,number,expectedUserId))return {status:'error',code:'approval-changed',message:'Состояние заявки изменилось во время выполнения. Проверьте доступ в GitHub; заявка автоматически не закрыта.'};
  await markSuccess(portal,number,kind);
  return {status:kind,issue:number,recipient:user.login,invitationSent:kind==='invited',invitationPending:kind==='invited'||kind==='pending'};
 } catch(error){
  const detail=safeError(error);
  if(approved){
   try{if(await currentApproval(portal,number,expectedUserId))await markFailure(portal,number,detail);}catch{/* Reporting failure must never hide the failed invite operation. */}
  }
  return {status:'error',...detail};
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let result;
 try{
  if(process.argv.includes('--check'))result=await checkConfiguration();
  else if(!process.env.GITHUB_EVENT_PATH)result={status:'error',code:'missing-event',message:'GITHUB_EVENT_PATH не задан.'};
  else result=await handleAccessRequest({event:JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'))});
 }catch{result={status:'error',code:'invalid-event',message:'Не удалось прочитать событие GitHub.'};}
 console.log(JSON.stringify(result));
 if(result.status==='error')process.exitCode=1;
}
