import { createSessionClient } from './session-client.js';
import { createConversationScroll } from './conversation-scroll.js';
import { createRequestReceipt, mountRequestCard, requestFinished } from './request-receipt.js';
import { createDraftStore } from './draft-store.js';
import { DEFAULT_TURN_PAGE_SIZE, applyComposerSuggestion, createLatestRequestGate, createTurnWindow, filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';
import { codexIcon, hydrateCodexIcons } from './codex-icons.js';
import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';
import { buildApprovalModel, createReviewPreferences, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';
import { browserSandboxFor, normalizeBrowserUrl } from './browser-panel.js';
import { createBridgeError, threadInputErrorMessage } from './bridge-errors.js';
import { createSettingsEditor } from './settings-editor.js';
import { createUserInputDialog } from './user-input.js';
import { buildTurnInput, readImageFiles } from './composer-input.js';
import { initializeMobileViewport, initializeSidebarDismiss, initializeMobileNavigation } from './mobile-ui.js';
initializeMobileViewport();
import lottie from 'lottie-web/build/player/lottie_light.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
const $ = (s) => document.querySelector(s);
const conversationScroll=createConversationScroll({root:$('#conversation'),button:$('#conversationLatest')});
let displayedThreadId=null,streamFrame=null;
const pendingStreamTurns=new Map();
function flushStreamTurns(){
  if(streamFrame!==null){cancelAnimationFrame(streamFrame);streamFrame=null}
  const root=$('#conversation'),position=root.scrollTop,following=conversationScroll.following();
  for(const {threadId,turn}of pendingStreamTurns.values())if(threadId===state.active?.id)renderSessionTurn(turn);
  pendingStreamTurns.clear();
  if(following)scrollBottom();else{root.scrollTop=position;conversationScroll.update()}
}
initializeSidebarDismiss({sidebar:$('#sidebar'),toggle:$('#toggleSidebar'),titleToggle:$('#threadHeadingButton'),close:()=>setSidebarOpen(false)});
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=(message,values)=>i18n.t(message,values);
const drafts=createDraftStore({rpc,onError:error=>{if(!error?.silentTransportSwitch)toast(t(error.message))}});
const showUserInputDialog=createUserInputDialog({respond:respondToCodex,t,getDraft:(id,key)=>drafts.get(id,`question:${key}`),saveDraft:(id,key,value)=>drafts.set(id,`question:${key}`,value)});
const state = { ws:null, events:null, transport:'connecting', wsFallbackTimer:null, rpcId:1, pending:new Map(), threads:[], active:null, models:[], selectedModel:'', workspaceContext:null, projectless:false, composerMode:'local', planMode:false, permissionMode:localStorage.getItem('codex-webui-permission-mode')||'default', permissionProfiles:[], permissionVisibility:{autoReview:true,fullAccess:localStorage.getItem('codex-webui-permission-full-access')!=='false'}, goalMode:false, backgroundAgentsVisible:false, cloudStartingState:null, placeholderText:null, composerMentions:[], composerImages:[], composerMessageId:'', queuedMessages:new Map(), turnWindow:null, tokenUsage:new Map(), items:new Map(), turns:new Map(), activities:new Map(), activityItems:new Map(), sideTasks:new Map(), dividers:new Map(), changes:new Map(), requestCards:new Map(), motion:new Map(), turnDiffs:new Map(), activeReview:null, account:null, connected:false, config:{home:'',defaultCwd:'',projectless:false} };
let folderBrowse={path:'~',parent:null,selected:null};
const reviewPreferences=createReviewPreferences(JSON.parse(localStorage.getItem('codex-webui-review-preferences')||'{}'));
let reviewPatchState='undo';
let sidePanelReturnFocus=null,summaryPanelReturnFocus=null,imageViewerReturnFocus=null;
let bottomPanelLastView=null;
let sidebarLayoutMobile=null;
let mobileNavigation=null;
let pendingFullAccessAction='select';
let settingsMobileLayout=matchMedia('(max-width:720px)').matches;
const createTerminalState=(hostId,panelId)=>({hostId,panelId,term:null,fit:null,ws:null,resizeObserver:null,reconnectTimer:null});
const terminalStates={bottom:createTerminalState('terminalHost','bottomPanel'),side:createTerminalState('sideTerminalHost','sidePanel')};
const browserState={history:[],index:-1,loadTimer:null,loadRequest:0};
const accountRequestGate=createLatestRequestGate();
const queueRequestGate=createLatestRequestGate();
const workspaceContextRequestGate=createLatestRequestGate();
const permissionProfileRequestGate=createLatestRequestGate();
const autocompleteState={match:null,items:[],selected:0,requestId:0,message:''};
const ACTIVE_THREAD_STORAGE_KEY='codex-webui-active-thread';
const SIDEBAR_PROJECT_EXPANSION_KEY='codex-webui-sidebar-project-expansion';
const sidebarProjectExpansion=(()=>{try{return JSON.parse(localStorage.getItem(SIDEBAR_PROJECT_EXPANSION_KEY)||'{}')}catch{return{}}})();
const THREAD_LIST_POLL_MS=3000;
let activeThreadSyncTimer=null,threadListTimer=null,threadListInFlight=false,threadListSignature='';

const icons = {
  chevron:codexIcon('chevronRight','activity-chevron'),
  terminal:codexIcon('terminal'),
  file:codexIcon('file'),
  search:codexIcon('search'),
  tool:codexIcon('wrench'),
  check:codexIcon('check'),
};
hydrateCodexIcons();
$('#windowCodexMark').innerHTML=codexInterfaceMark('window-codex-mark');
$('#emptyCodexMark').innerHTML=codexInterfaceMark('empty-codex-mark');

const WS_CONNECT_TIMEOUT_MS=5000;
const bridgeClientId=crypto.randomUUID();
function transportSwitchError(){const error=new Error('Bridge transport changed');error.silentTransportSwitch=true;return error}
function clearWsFallbackTimer(){clearTimeout(state.wsFallbackTimer);state.wsFallbackTimer=null}
function rejectWebSocketPending(){for(const pending of state.pending.values())pending.reject(transportSwitchError());state.pending.clear()}
async function postBridge(path,payload){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,clientId:bridgeClientId}),cache:'no-store'}),data=await response.json().catch(()=>({}));if(!response.ok)throw createBridgeError(data.error||'Codex bridge request failed',data.code);return data}
function connectSse(){
  if(state.events)return;
  state.transport='sse';state.connected=false;setStatus('connecting','Connecting to Codex');
  const events=new EventSource(`/api/events?clientId=${bridgeClientId}`);state.events=events;
  events.onmessage=event=>{try{handle(JSON.parse(event.data))}catch{}};
  events.onerror=()=>{if(state.events===events){state.connected=false;sessionClient.disconnect();setStatus('connecting','Connecting to Codex')}};
}
function fallbackToSse(ws){
  if(state.transport==='sse'||(ws&&state.ws!==ws))return;
  clearWsFallbackTimer();rejectWebSocketPending();state.connected=false;sessionClient.disconnect();
  if(ws){ws.onopen=ws.onmessage=ws.onerror=ws.onclose=null;try{ws.close()}catch{}}
  state.ws=null;connectSse();
}
function connect(){
  if(state.transport==='sse'||state.ws)return;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  let ws;
  try{ws=new WebSocket(`${proto}//${location.host}/ws`)}catch{fallbackToSse();return}
  state.transport='ws';state.ws=ws;
  const fallback=()=>fallbackToSse(ws);
  state.wsFallbackTimer=setTimeout(fallback,WS_CONNECT_TIMEOUT_MS);
  ws.onopen=()=>{if(state.ws===ws)setStatus('connecting','Connecting to Codex')};
  ws.onmessage=(event)=>{if(state.ws!==ws)return;try{const message=JSON.parse(event.data);clearWsFallbackTimer();handle(message)}catch{fallback()}};
  ws.onerror=fallback;ws.onclose=fallback;
}
function rpc(method,params={}){
  const id=state.rpcId++;
  if(state.transport==='sse')return postBridge('/api/rpc',{id,method,params}).then(message=>{if(message.type!=='rpc/result')throw createBridgeError(message.error||'Codex bridge request failed',message.code);return message.result});
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>state.pending.set(id,{resolve,reject}))}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}
  return Promise.reject(transportSwitchError());
}
function respondToCodex(requestId,result,error){
  const request=serverRequests.get(requestId);
  return rpc('host/request/respond',{requestId,threadId:request?.params?.threadId,requestKey:request?.requestKey,result,error});
}
const serverRequests=new Map();
const openThreadGate=createLatestRequestGate();
let serverRequestRevision=0;
function resolveServerRequest(id){serverRequestRevision++;serverRequests.delete(id);showUserInputDialog.resolve(id);state.requestCards.get(id)?.remove();state.requestCards.delete(id)}
function resetServerRequests(){serverRequestRevision++;serverRequests.clear();showUserInputDialog.clear();for(const card of state.requestCards.values())card.remove();state.requestCards.clear()}
function renderServerRequests(){
  for(const card of state.requestCards.values())card.remove();
  state.requestCards.clear();
  showUserInputDialog.setThread(state.active?.id||null);
  for(const request of serverRequests.values())if(request.params?.threadId===state.active?.id&&request.method!=='item/tool/requestUserInput')onApprovalRequest(request);
}
const sessionClient=createSessionClient({rpc,onState:applySessionState,onError:error=>{if(!error?.silentTransportSwitch)setStatus('connecting','Connecting to Codex')}});
function composerDraftOwner(){return state.active?.id||`draft:new:${currentComposerCwd()||'tasks'}`}
let composerDraftReady=false,currentDraftOwner=null,composerDirty=false;
function saveComposerDraft(){if(!composerDraftReady)return;composerDirty=true;drafts.set(currentDraftOwner||composerDraftOwner(),'composer',{text:$('#prompt').value,mentions:state.composerMentions,images:state.composerImages})}
function restoreComposerDraft(force=false){const owner=composerDraftOwner();if(!force&&composerDraftReady&&currentDraftOwner===owner&&composerDirty)return;currentDraftOwner=owner;composerDirty=false;composerDraftReady=true;const value=drafts.get(currentDraftOwner,'composer');$('#prompt').value=value?.text||'';state.composerMentions=value?.mentions||[];state.composerImages=value?.images||[];state.composerMessageId='';renderContextTray();resizePrompt()}
function applySessionState(snapshot,patch,initial){
  if(snapshot.thread.id!==state.active?.id)return;
  if(patch?.delta){
    state.active={...state.active,...snapshot.thread};
    const turn=snapshot.thread.turns.find(turn=>turn.id===patch.delta.turnId);
    if(turn){pendingStreamTurns.set(turn.id,{threadId:snapshot.thread.id,turn});if(streamFrame===null)streamFrame=requestAnimationFrame(flushStreamTurns)}
    return;
  }
  if(pendingStreamTurns.size)flushStreamTurns();
  const opening=displayedThreadId!==snapshot.thread.id;displayedThreadId=snapshot.thread.id;
  const root=$('#conversation'),nearBottom=conversationScroll.following(),previousScroll=root.scrollTop;
  const wasActive=patch?.turn&&state.active.turns?.some(turn=>turn.id===patch.turn.id&&turn.status==='inProgress');
  state.active={...state.active,...snapshot.thread};
  syncThreadStatus(snapshot.thread.id,snapshot.thread.status);
  if(initial||patch?.drafts){drafts.hydrate(state.active.id,snapshot.drafts);if(initial)restoreComposerDraft()}
  if(initial||patch?.queue){state.queuedMessages.set(state.active.id,snapshot.queue||[]);renderQueuedMessages()}
  if(initial||patch?.tokenUsage){if(snapshot.tokenUsage)state.tokenUsage.set(state.active.id,snapshot.tokenUsage);renderContextUsage()}
  if(initial||patch?.requests){
    serverRequests.clear();for(const record of snapshot.requests||[])serverRequests.set(record.request.id,{...record.request,requestKey:record.key,requestStatus:record.status});
    showUserInputDialog.sync(snapshot.requests||[],snapshot.drafts);
  }
  if(initial||patch?.thread?.turns){renderThread(state.active);renderHeader();renderThreads()}
  else if(patch?.turn)renderSessionTurn(patch.turn);
  if(initial||patch?.requests||patch?.turn||patch?.thread?.turns)renderServerRequests();
  if(initial||patch?.diffs){for(const[turnId,diff]of Object.entries(snapshot.diffs||{}))recordTurnReview(turnId,diff,'native')}
  const active=(state.active.turns||[]).findLast(turn=>turn.status==='inProgress');setActiveTurnId(active?.id||'');
  if(patch?.thread&&!patch.thread.turns){const listed=state.threads.find(thread=>thread.id===state.active.id);if(listed)Object.assign(listed,patch.thread);$('#threadTitle').textContent=titleOf(state.active);renderThreads()}
  if(wasActive&&patch.turn.status!=='inProgress'){maybeNotifyTaskCompleted({threadId:state.active.id,turn:patch.turn});refreshThreadsSoon()}
  if(patch?.error)toast(snapshot.error.message);
  if(opening||nearBottom)scrollBottom(opening);else{root.scrollTop=previousScroll;conversationScroll.update()}
}
function renderSessionTurn(turn){
  const root=$('#conversation'),old=state.turns.get(turn.id),marker=document.createComment('turn');
  root.querySelector('#emptyState')?.remove();root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());
  if(old?.isConnected)old.before(marker);else root.append(marker);
  const previous=old?._snapshot;
  if(old?.isConnected&&previous&&JSON.stringify((previous.items||[]).map(item=>[item.id,item.type]))===JSON.stringify((turn.items||[]).map(item=>[item.id,item.type]))){for(const[index,item]of(turn.items||[]).entries())if(JSON.stringify(previous.items[index])!==JSON.stringify(item))upsertItem(item,turn.id,root,false);syncTurnTiming(turn,root);old._snapshot=structuredClone(turn);marker.remove();return}
  const pending=[];
  for(const node of root.querySelectorAll('.user-turn'))if(node.dataset.userTurnId===turn.id){if(node._submitted&&node.dataset.pendingMessageId)pending.push(node._submitted);node.remove()}
  for(const[node,animation]of state.motion)if(old?.contains(node)){animation.destroy();state.motion.delete(node)}
  old?.remove();state.turns.delete(turn.id);state.dividers.delete(turn.id);state.activities.delete(turn.id);state.activityItems.delete(turn.id);
  for(const[id,node]of state.items)if(!node.isConnected)state.items.delete(id);
  const staging=document.createElement('div');staging.hidden=true;root.append(staging);renderTurn(turn,staging);marker.before(...staging.childNodes);marker.remove();staging.remove();
  for(const submitted of pending)showSubmittedMessage(submitted);
}

function handle(message){
  if(message.type==='session/event'){sessionClient.receive(message);return}
  if(message.type==='bridge/requests/reset'){resetServerRequests();return}
  if(message.type==='bridge/status'){
    if(message.status==='connected'){const shouldLoad=!state.connected;state.connected=true;setStatus('connected','Codex connected');if(shouldLoad){loadInitial();requestTaskNotifyPermission()}}
    else{state.connected=false;sessionClient.disconnect();setStatus('connecting','Connecting to Codex')}
    return;
  }
  if(message.type==='rpc/result'||message.type==='rpc/error'){
    const p=state.pending.get(message.id);if(!p)return;state.pending.delete(message.id);
    message.type==='rpc/result'?p.resolve(message.result):p.reject(createBridgeError(message.error,message.code));return;
  }
  if(message.type==='bridge/queue'){if(message.threadId===state.active?.id)queueRequestGate.next();state.queuedMessages.set(message.threadId,message.messages||[]);renderQueuedMessages();return}
  if(message.type==='bridge/message')return
  if(message.type==='codex/notification') onNotification(message.payload.method,message.payload.params||{});
  if(message.type==='codex/request') onServerRequest(message.payload);
}
function setStatus(kind,text){
  $('#statusDot').className='status-dot'+(kind==='connected'?' connected':kind==='error'?' error':'');
  $('#statusText').textContent=t(text||kind);
}
async function loadInitial(refreshAccount=false){
  if(state.active)sessionClient.reconnect();drafts.retry();
  loadAccount(refreshAccount);
  try{const [models,threads,profiles]=await Promise.all([rpc('model/list',{limit:50}),rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'}),rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100}).catch(()=>({data:[]}))]);
    state.models=filterAppModels(models.data||[]);renderModels();applyThreadSummaries(threads.data||[]);setPermissionProfiles(profiles.data||[]);scheduleThreadListRefresh();const rememberedThread=localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);if(!state.active&&rememberedThread)await openThread(rememberedThread);else if(!state.active){const owner=composerDraftOwner();await drafts.load(owner).catch(()=>{});if(!state.active&&owner===composerDraftOwner())restoreComposerDraft()}if($('#settingsDialog').open&&document.querySelector('[data-settings-page="agent"].active'))setSettingsPage('agent',{updateRoute:false});
  }catch(e){if(!e?.silentTransportSwitch)toast(e.message);}
}
async function loadAccount(refresh=false){
  const requestId=accountRequestGate.next();
  try{const response=await fetch(`/api/account${refresh?'?refresh=1':''}`,{cache:'no-store'}),account=await response.json();if(!response.ok)throw new Error(account.error||'Cannot load account');if(!accountRequestGate.isCurrent(requestId))return;state.account=account;renderAccount(account)}catch{if(accountRequestGate.isCurrent(requestId))renderAccount({displayName:null,avatarUrl:null,planType:null,initials:'?'})}
}
let profileSaving=false,profileAvatarData=null,profileAvatarRead=0;
$('#profileAvatarFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0],feedback=$('#profileFeedback'),generation=++profileAvatarRead;
  profileAvatarData=null;feedback.textContent='';
  if(!file){if(state.account)renderAccount(state.account);return}
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>2*1024*1024){event.target.value='';feedback.textContent=t('Use a PNG, JPEG, WebP or GIF image up to 2 MB.');return}
  $('#saveProfile').disabled=true;
  try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader;reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read image. Choose another image.'));reader.readAsDataURL(file)});
    const image=new Image;image.alt='';image.src=data;await image.decode();
    if(generation!==profileAvatarRead)return;
    profileAvatarData=data;const avatar=$('#settingsAccountAvatar');avatar.dataset.imageUrl='';avatar.className='account-avatar';avatar.replaceChildren(image);
  }catch{if(generation===profileAvatarRead){event.target.value='';feedback.textContent=t('Could not read image. Choose another image.')}}
  finally{if(generation===profileAvatarRead)$('#saveProfile').disabled=profileSaving||!state.account?.type}
});
$('#profileForm').addEventListener('submit',async event=>{
  event.preventDefault();if(profileSaving)return;
  const input=$('#profileDisplayName'),feedback=$('#profileFeedback'),button=$('#saveProfile'),displayName=input.value.trim();
  if(!displayName){input.focus();return}
  profileSaving=true;$('#profileAvatarFile').disabled=true;input.disabled=true;button.disabled=true;button.textContent=t('Saving profile…');feedback.textContent='';
  accountRequestGate.next();
  try{
    const response=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName,...(profileAvatarData?{avatar:profileAvatarData}:{})})});
    const account=await response.json();if(!response.ok)throw new Error(account.error||'Could not save profile. Try again.');
    accountRequestGate.next();profileAvatarData=null;$('#profileAvatarFile').value='';renderAccount(account);input.value=account.displayName;feedback.textContent=t('Profile saved.');
  }catch(error){feedback.textContent=t(error.message)}
  finally{profileSaving=false;$('#profileAvatarFile').disabled=false;input.disabled=false;button.disabled=false;button.textContent=t('Save profile')}
});
function renderAccount(account){
  state.account=account;
  const profileInput=$('#profileDisplayName');if(document.activeElement!==profileInput&&!profileSaving)profileInput.value=account?.displayName||'';profileInput.disabled=profileSaving||!account?.type;$('#saveProfile').disabled=profileInput.disabled;
  const displayName=account?.displayName?.trim()||t('Settings'),initials=account?.initials?.trim()||'?',type=account?.type||'unknown',plan=account?.planType?`${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)} plan`:type==='apiKey'?t('API key mode'):type==='amazonBedrock'?'Amazon Bedrock':'';
  const profileMenuAvailable=type==='chatgpt';
  $('#accountName').textContent=displayName;$('#accountMenuName').textContent=displayName;$('#settingsAccountName').textContent=displayName;$('#accountFooterMeta').textContent='';$('#accountMenuSubtitle').textContent=plan;$('#settingsAccountMeta').textContent=plan||t('Codex account');
  $('#accountButton').setAttribute('aria-label',profileMenuAvailable?'Open profile menu':'Open settings');
  const avatarUrl=profileMenuAvailable&&typeof account?.avatarUrl==='string'&&account.avatarUrl.startsWith('/api/account/avatar')?account.avatarUrl:'',profileAvatars=[$('#accountMenuAvatar'),$('#settingsAccountAvatar')],footerAvatar=$('#accountAvatar'),profileAvatarClass=avatar=>`account-avatar${avatar.id==='accountMenuAvatar'?' account-menu-avatar':''}`;for(const avatar of profileAvatars){avatar.dataset.imageUrl=avatarUrl;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}
  if(profileMenuAvailable){footerAvatar.dataset.imageUrl=avatarUrl;footerAvatar.className='account-avatar account-initials';footerAvatar.textContent=initials;profileAvatars.unshift(footerAvatar)}else{footerAvatar.dataset.imageUrl='';footerAvatar.className='account-avatar account-settings-icon';footerAvatar.innerHTML=codexIcon('wrench')}
  if(avatarUrl){const image=new Image;image.alt='';image.src=`${avatarUrl}?v=${Date.now()}`;image.onload=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=profileAvatarClass(avatar);avatar.replaceChildren(image.cloneNode())}};image.onerror=()=>{for(const avatar of profileAvatars){if(avatar.dataset.imageUrl!==avatarUrl)continue;avatar.className=`${profileAvatarClass(avatar)} account-initials`;avatar.textContent=initials}}}
  if(!profileMenuAvailable)toggleAccountMenu(false);
  const apiMode=!profileMenuAvailable;$('#accountProfile').hidden=apiMode;$('#accountLogout').hidden=apiMode;
  const accountSettingsPage=$('[data-settings-page="profile"]');if(accountSettingsPage){accountSettingsPage.dataset.settingsAvailable=String(!apiMode);if(apiMode&&accountSettingsPage.classList.contains('active'))setSettingsPage('general-settings');filterSettingsNavigation($('#settingsSearch')?.value||'')}
  syncPermissionSettings();syncPermissionControl();
}
function toggleAccountMenu(force){const menu=$('#accountMenu'),open=force??menu.hidden;menu.hidden=!open;$('#accountButton').setAttribute('aria-expanded',String(open))}
const settingsPageAliases={general:'general-settings',account:'profile',keyboard:'keyboard-shortcuts'};
const settingsPages={
  'general-settings':{title:'General'},appearance:{title:'Appearance'},'access-settings':{title:'Public access'},agent:{title:'Configuration'},'global-instructions':{title:'Global instructions'},profile:{title:'Profile'},'keyboard-shortcuts':{title:'Keyboard shortcuts'},
  'plugins-settings':{title:'Plugins'},'skills-settings':{title:'Skills'},'browser-use':{title:'Browser'},
  connections:{title:'MCP servers'},'code-review':{title:'Code review'},
};
function normalizeSettingsPage(page='general-settings'){const candidate=settingsPageAliases[page]||page;return settingsPages[candidate]?candidate:'general-settings'}
function settingsRoutePage(pathname=location.pathname){const match=pathname.match(/^\/settings(?:\/([^/]+))?\/?$/);return match?normalizeSettingsPage(match[1]||'general-settings'):null}
const settingsEditor=createSettingsEditor({
  t,rpc,toast,cwd:()=>currentComposerCwd()||state.config.defaultCwd,
  models:()=>state.models,model:()=>state.selectedModel,chooseModel,
  effort:()=>$('#effortSelect').value,efforts:()=>[...$('#effortSelect').options].map(option=>[option.value,reasoningLabel(option.value)]),chooseEffort,
  permissions:()=>['default',...(autoReviewSupported()?['guardian-approvals']:[]),...(state.permissionVisibility.fullAccess?['full-access']:[]),...state.permissionProfiles.map(profile=>`${PERMISSION_PROFILE_PREFIX}${profile.id}`)].filter(mode=>permissionModeAvailable(mode)).map(mode=>[mode,permissionModeDefinition(mode).label]),
  permission:()=>state.permissionMode,choosePermission:mode=>{choosePermissionMode(mode);return undefined},
  review:()=>reviewPreferences,setReview:(key,value)=>{reviewPreferences[key]=value;saveReviewPreferences();renderChanges()},
  closeSettings,openBrowser:()=>openUtilityPanel('browser'),
});
let integrationSettingsRequest=0;
function appendIntegrationRow(container,label,value,detail=''){
  const row=document.createElement('div'),copy=document.createElement('span'),name=document.createElement('strong'),status=document.createElement('span');
  row.className='settings-row settings-readonly-row';name.textContent=label;copy.append(name);status.textContent=value;
  if(detail){const description=document.createElement('small');description.textContent=detail;copy.append(description)}
  row.append(copy,status);container.append(row);return {row,status};
}
function integrationToggle(container,label,enabled,detail,save,disabled=false){
  const {row,status}=appendIntegrationRow(container,label,'',detail),select=document.createElement('select');
  select.className='settings-select';select.setAttribute('aria-label',label);
  for(const [value,title] of [['true','Enabled'],['false','Disabled']]){const option=document.createElement('option');option.value=value;option.textContent=t(title);select.append(option)}
  select.value=String(enabled);select.disabled=disabled;status.replaceWith(select);
  select.onchange=async()=>{select.disabled=true;try{const result=await save(select.value==='true');enabled=result?.effectiveEnabled??(select.value==='true');select.value=String(enabled);toast(t('Saved. Start a new chat to use this setting.'))}catch(error){select.value=String(enabled);toast(error.message)}finally{select.disabled=disabled}};
  return row;
}
async function loadIntegrationSettings(page,rows){
  const requestId=++integrationSettingsRequest,isSkills=page==='skills-settings',cwd=currentComposerCwd()||state.config.defaultCwd;
  const toolbar=document.createElement('div'),refresh=document.createElement('button'),content=document.createElement('div');
  toolbar.className='settings-toolbar';refresh.type='button';refresh.className='integration-refresh';refresh.textContent=t('Refresh');refresh.disabled=true;
  refresh.onclick=()=>loadIntegrationSettings(page,rows);toolbar.append(refresh);content.className='integration-settings-list';content.setAttribute('role','status');content.textContent=t('Loading…');rows.replaceChildren(toolbar,content);
  try{
    const entries=[];let cursor=null;
    do{
      const result=await rpc(isSkills?'skills/list':'mcpServerStatus/list',isSkills?{cwds:cwd?[cwd]:[],forceReload:true}:{limit:100,...(state.active?.id?{threadId:state.active.id}:{}),...(cursor?{cursor}:{})});
      if(requestId!==integrationSettingsRequest)return;
      entries.push(...(result.data||[]));cursor=isSkills?null:result.nextCursor;
    }while(cursor);
    content.replaceChildren();
    if(isSkills){
      const skills=new Map();for(const entry of entries)for(const skill of entry.skills||[])skills.set(skill.path,skill);
      for(const skill of [...skills.values()].sort((a,b)=>a.name.localeCompare(b.name)))integrationToggle(content,skill.interface?.displayName||skill.name,skill.enabled!==false,skill.interface?.shortDescription||skill.shortDescription||skill.description,enabled=>rpc('host/skills/set-enabled',{cwd,path:skill.path,enabled}));
      for(const entry of entries)for(const error of entry.errors||[])appendIntegrationRow(content,t('Cannot load skill'),t('Failed'),`${error.path}: ${error.message}`);
      if(!content.childElementCount)content.textContent=t('No skills found');
    }else{
      const statuses={notStarted:'Not started',starting:'Connecting…',connected:'Connected',authenticationRequired:'Sign in required',failed:'Failed',cancelled:'Cancelled',disabled:'Disabled'};
      const authStatuses={unknown:'Unknown',unsupported:'No authentication required',notLoggedIn:'Sign in required',bearerToken:'Token configured',oAuth:'Signed in'};
      const settings=await rpc('host/settings/read',{cwd});
      if(requestId!==integrationSettingsRequest)return;
      const names=new Set();
      for(const server of entries){
        names.add(server.name);const configured=settings.mcpServers.find(item=>item.name===server.name),status=t(statuses[server.runtimeStatus]||authStatuses[server.authStatus]||'Unknown');
        const detail=`${status} · ${server.toolsError||`${t('Tools')}: ${Object.keys(server.tools||{}).length}`}`;
        if(configured)integrationToggle(content,server.name,configured.enabled,detail,enabled=>rpc('host/mcp/set-enabled',{name:server.name,enabled}),!/^[a-zA-Z0-9_-]+$/.test(server.name));
        else appendIntegrationRow(content,server.name,status,detail);
      }
      for(const server of settings.mcpServers)if(!names.has(server.name))integrationToggle(content,server.name,server.enabled,t(server.enabled?'Not started':'Disabled'),enabled=>rpc('host/mcp/set-enabled',{name:server.name,enabled}),!/^[a-zA-Z0-9_-]+$/.test(server.name));
      if(!content.childElementCount)content.textContent=t('No MCP servers found');
    }
  }catch(error){if(requestId===integrationSettingsRequest)content.textContent=`${t('Cannot load Codex integrations')}: ${error.message}`}
  finally{if(requestId===integrationSettingsRequest)refresh.disabled=false}
}
function renderSettingsPlaceholder(page){
  integrationSettingsRequest++;settingsEditor.cancel();
  $('#settingsPlaceholderTitle').textContent=t(settingsPages[page].title);
  $('#settingsPlaceholderDescription').hidden=true;
  const rows=$('#settingsPlaceholderRows');rows.replaceChildren();
  if(page==='skills-settings'||page==='connections')loadIntegrationSettings(page,rows);
  else settingsEditor.render(page,rows);
}
function setSettingsPage(page='general-settings',{updateRoute=true}={}){
  const selected=normalizeSettingsPage(page),contentPage=['general-settings','appearance','profile','keyboard-shortcuts'].includes(selected)?selected:'placeholder';
  integrationSettingsRequest++;settingsEditor.cancel();
  for(const button of document.querySelectorAll('[data-settings-page]'))button.classList.toggle('active',button.dataset.settingsPage===selected);
  for(const content of document.querySelectorAll('[data-settings-content]'))content.hidden=content.dataset.settingsContent!==contentPage;
  if(contentPage==='placeholder')renderSettingsPlaceholder(selected);
  $('#settingsPageTitle').textContent=t(settingsPages[selected].title);$('#settingsContent')?.scrollTo({top:0});
  if(updateRoute&&settingsRoutePage())history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}`);
}
function filterSettingsNavigation(query=''){const normalized=query.trim().toLocaleLowerCase(),clear=$('#clearSettingsSearch');let visible=0;if(clear)clear.hidden=!normalized;for(const group of document.querySelectorAll('[data-settings-group]')){let groupVisible=0;for(const button of group.querySelectorAll('[data-settings-page]')){const available=button.dataset.settingsAvailable!=='false',matches=!normalized||button.textContent.toLocaleLowerCase().includes(normalized);button.hidden=!available||!matches;if(!button.hidden){groupVisible++;visible++}}group.hidden=groupVisible===0}$('#settingsNavEmpty').hidden=visible!==0}
function clearSettingsSearch(){const input=$('#settingsSearch');input.value='';filterSettingsNavigation();input.focus()}
function showSettingsMobileNavigation(){const dialog=$('#settingsDialog');dialog.dataset.mobilePage='false';requestAnimationFrame(()=>$('#settingsSearch').focus())}
function syncSettingsResponsiveLayout(){const mobile=matchMedia('(max-width:720px)').matches;if(mobile===settingsMobileLayout)return;settingsMobileLayout=mobile;const dialog=$('#settingsDialog');if(dialog.open)dialog.dataset.mobilePage=String(mobile)}
function hideSettings(){integrationSettingsRequest++;settingsEditor.cancel();const dialog=$('#settingsDialog');if(dialog.open)dialog.close();document.body.classList.remove('settings-open')}
function closeSettings(){if(settingsRoutePage()){if(typeof history.state?.codexSettingsReturnPath==='string'){history.back();return}history.replaceState({},'','/');hideSettings();return}hideSettings()}
$('#closeSettingsNav').onclick=closeSettings;$('#settingsMobileBack').onclick=showSettingsMobileNavigation;for(const button of document.querySelectorAll('.settings-page .settings-mobile-back'))button.onclick=showSettingsMobileNavigation;$('#settingsSearch').oninput=event=>filterSettingsNavigation(event.currentTarget.value);$('#clearSettingsSearch').onclick=clearSettingsSearch;$('#settingsSearch').onkeydown=event=>{if(event.key==='Escape'&&event.currentTarget.value){event.preventDefault();clearSettingsSearch()}};addEventListener('resize',syncSettingsResponsiveLayout);addEventListener('popstate',()=>{const page=settingsRoutePage();if(page){showSettings(page,{updateRoute:false});return}hideSettings()});
function showSettings(page='general-settings',{updateRoute=true}={}){toggleAccountMenu(false);syncPermissionSettings();$('#settingsPermissionValue').textContent=t(selectedPermission().label);$('#settingsProjectValue').textContent=state.projectless?t('No project'):shortPath(state.active?.cwd||$('#projectPath').textContent);$('#settingsSearch').value='';filterSettingsNavigation();setSettingsPage(page,{updateRoute});const dialog=$('#settingsDialog'),mobile=matchMedia('(max-width:720px)').matches;settingsMobileLayout=mobile;dialog.dataset.mobilePage=String(mobile);if(!dialog.open)dialog.show();document.body.classList.add('settings-open');requestAnimationFrame(()=>{const target=mobile?$('#settingsSearch'):document.querySelector('.settings-nav-back');target?.focus()})}
function openSettings(page='general-settings'){const selected=normalizeSettingsPage(page),current=settingsRoutePage();if(!current){history.pushState({codexWebuiSettings:true,codexSettingsReturnPath:location.pathname+location.search+location.hash},'',`/settings/${selected}`)}else if(current!==selected){history.replaceState({...history.state,codexWebuiSettings:true},'',`/settings/${selected}`)}showSettings(selected,{updateRoute:false})}
function reasoningLabel(value){return String(value||'medium').toLowerCase()}
function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;return value.replace(/^GPT-/i,'').trim()||value}
function selectedModel(){return state.models.find(x=>x.model===state.selectedModel)}
function renderModels(){
  const saved=localStorage.getItem('codex-webui-model'),selection=selectModelState(state.models,saved);state.selectedModel=selection.model;
  updateEfforts(selection.effort);syncModelLabel();renderModelMenuMain();
}
function chooseModel(model,keepOpen=false){const previous=$('#effortSelect').value;state.selectedModel=model;localStorage.setItem('codex-webui-model',model);updateEfforts(previous);syncModelLabel();if(keepOpen)renderModelMenuMain();else closeModelMenu();toast(`Model: ${modelDisplay(selectedModel())}`)}
function syncModelLabel(){const model=selectedModel();$('#modelLabel').textContent=modelDisplay(model,true);$('#effortLabel').textContent=reasoningLabel($('#effortSelect').value)}
function updateEfforts(preferred){
  const model=selectedModel(),effort=$('#effortSelect');effort.innerHTML='';
  const supported=model?.supportedReasoningEfforts||[{reasoningEffort:'medium'}],values=supported.map(item=>item.reasoningEffort).filter(Boolean),saved=localStorage.getItem(`codex-webui-effort:${state.selectedModel}`),selected=[saved,preferred,model?.defaultReasoningEffort,values[0],'medium'].find(value=>values.includes(value))||'medium';
  for(const value of values.length?values:['medium']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===selected;effort.append(option)}
  $('#effortLabel').textContent=reasoningLabel(effort.value);
}
function contextUsageValue(tokenUsage){const contextWindow=Number(tokenUsage?.modelContextWindow),totalTokens=Number(tokenUsage?.last?.totalTokens);if(!Number.isFinite(contextWindow)||contextWindow<=0||!Number.isFinite(totalTokens)||totalTokens<0)return null;const usedTokens=Math.min(totalTokens,contextWindow),percent=usedTokens/contextWindow*100;return Number.isFinite(percent)?{percent,usedTokens,contextWindow,remainingTokens:Math.max(contextWindow-usedTokens,0)}:null}
function refreshMobileUsage(){
  const usage=state.active?.id?contextUsageValue(state.tokenUsage.get(state.active.id)):null;
  $('#mobileUsageValue').textContent=usage?`${Math.round(usage.percent)}% · ${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()}`:t('No usage data yet');
  $('#mobileUsageProgress').style.width=`${usage?Math.max(0,Math.min(usage.percent,100)):0}%`;
  $('#mobileUsageModel').textContent=$('#modelLabel').textContent;
}
function renderContextUsage(){refreshMobileUsage();const indicator=$('#contextUsage'),usage=state.active?.id?contextUsageValue(state.tokenUsage.get(state.active.id)):null;if(!indicator)return;if(!usage){indicator.hidden=true;indicator.removeAttribute('data-tooltip');return}const percent=Math.max(0,Math.min(usage.percent,100)),rounded=Math.round(percent),remaining=Math.max(0,100-rounded),usedThousands=Math.round(usage.usedTokens/1000),windowThousands=Math.round(usage.contextWindow/1000),status=rounded>=50?`${rounded}% full`:`${rounded}% used (${remaining}% left)`;indicator.hidden=false;indicator.style.setProperty('--context-percent',String(percent));indicator.setAttribute('aria-label',`Context usage: ${rounded}%`);indicator.dataset.tooltip=`Context window:\n${status}\n${usedThousands}k / ${windowThousands}k tokens used`}
function menuTitle(text,back=false){return `<div class="model-menu-title-row">${back?`<button type="button" class="model-menu-back" id="modelMenuBack" aria-label="Back">${codexIcon('chevronLeft')}</button>`:''}<div class="model-menu-title">${escapeHtml(text)}</div></div>`}
function renderModelMenuMain(){const menu=$('#modelMenu'),model=selectedModel(),effort=$('#effortSelect');menu.innerHTML=`<div class="model-menu-view model-menu-view-main">${menuTitle('Reasoning')}<div class="model-menu-list" data-model-menu-efforts></div><div class="model-menu-separator"></div><button type="button" class="model-submenu-button" id="modelSubmenuButton"><span>Model</span><span class="model-submenu-value">${escapeHtml(modelDisplay(model))}</span>${codexIcon('chevronRight')}</button></div>`;const list=menu.querySelector('[data-model-menu-efforts]');for(const option of effort.options){const button=document.createElement('button');button.type='button';button.className='model-effort-row';button.dataset.value=option.value;button.setAttribute('aria-checked',String(option.selected));button.innerHTML=`<span data-i18n-ignore>${escapeHtml(reasoningLabel(option.value))}</span><span class="model-check">${option.selected?codexIcon('check'):''}</span>`;button.onclick=()=>chooseEffort(option.value);list.append(button)}menu.querySelector('#modelSubmenuButton').onclick=renderModelSubmenu}
function renderModelSubmenu(){const menu=$('#modelMenu');menu.innerHTML=`<div class="model-menu-view model-menu-view-models">${menuTitle('Model',true)}<div class="model-menu-list model-list"></div></div>`;menu.querySelector('#modelMenuBack').onclick=renderModelMenuMain;const list=menu.querySelector('.model-list');for(const model of state.models){const button=document.createElement('button');button.type='button';button.className='model-option';button.role='menuitemradio';button.dataset.model=model.model;button.setAttribute('aria-checked',String(model.model===state.selectedModel));button.innerHTML=`<span class="model-option-copy"><strong>${escapeHtml(modelDisplay(model))}</strong>${model.description?`<small>${escapeHtml(model.description)}</small>`:''}</span><span class="model-check">${model.model===state.selectedModel?codexIcon('check'):''}</span>`;button.onclick=()=>chooseModel(model.model);list.append(button)}}
function chooseEffort(value){const effort=$('#effortSelect');if(![...effort.options].some(option=>option.value===value))return;effort.value=value;$('#effortLabel').textContent=reasoningLabel(value);localStorage.setItem(`codex-webui-effort:${state.selectedModel}`,value);closeModelMenu();toast(`Reasoning: ${reasoningLabel(value)}`)}
function openModelMenu(view='main'){if(view==='models')renderModelSubmenu();else renderModelMenuMain();$('#modelMenu').hidden=false;$('#modelButton').setAttribute('aria-expanded','true')}
function toggleModelMenu(){const menu=$('#modelMenu');if(menu.hidden)openModelMenu();else closeModelMenu()}
function closeModelMenu(){const menu=$('#modelMenu');menu.hidden=true;$('#modelButton').setAttribute('aria-expanded','false')}
const permissionModes={
  default:{kind:'legacy',label:'Ask for approval',description:'Always ask for permission before editing external files or using the internet',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write'},
  'guardian-approvals':{kind:'legacy',label:'Approve for me',description:'Only ask for actions detected as potentially unsafe',icon:'shield',approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:'workspace-write'},
  'full-access':{kind:'legacy',label:'Full access',description:'Unrestricted access to the internet and any file on your computer',icon:'terminal',approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'},
};
const PERMISSION_PROFILE_PREFIX='profile:';
const RESERVED_PERMISSION_PROFILE_IDS=new Set(['default','guardian-approvals','full-access','custom']);
function permissionProfileCwd(){if(state.projectless)return null;const path=state.active?.cwd||state.workspaceContext?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||null;return typeof path==='string'&&path.startsWith('~')?state.config.home+path.slice(1):path}
function permissionProfileId(mode=state.permissionMode){return String(mode||'').startsWith(PERMISSION_PROFILE_PREFIX)?String(mode).slice(PERMISSION_PROFILE_PREFIX.length):null}
function autoReviewSupported(){return state.account?.type==='chatgpt'}
function permissionModeDefinition(mode=state.permissionMode){if(permissionModes[mode])return{mode,...permissionModes[mode]};const profileId=permissionProfileId(mode),profile=profileId&&state.permissionProfiles.find(item=>item.id===profileId);return profile?{kind:'profile',mode,profileId,label:profile.id,description:profile.description||'Custom permission profile',icon:'file',allowed:profile.allowed!==false}:null}
function permissionModeAvailable(mode=state.permissionMode){const selected=permissionModeDefinition(mode);if(!selected||selected.allowed===false)return false;if(mode==='guardian-approvals')return autoReviewSupported();if(mode==='full-access')return state.permissionVisibility.fullAccess;return true}
function normalizePermissionMode(){if(permissionModeAvailable())return;state.permissionMode='default';localStorage.setItem('codex-webui-permission-mode','default')}
function selectedPermission(){normalizePermissionMode();return permissionModeDefinition()||{mode:'default',...permissionModes.default}}
function setPermissionProfiles(profiles=[]){const seen=new Set;state.permissionProfiles=(Array.isArray(profiles)?profiles:[]).flatMap(profile=>{if(!profile||typeof profile.id!=='string')return[];const id=profile.id.trim(),key=id.toLocaleLowerCase();if(!id||id.startsWith(':')||RESERVED_PERMISSION_PROFILE_IDS.has(key)||seen.has(key))return[];seen.add(key);return[{id,description:typeof profile.description==='string'?profile.description:'',allowed:profile.allowed!==false}]});normalizePermissionMode();syncPermissionControl()}
async function loadPermissionProfiles(){if(!state.connected)return;const requestId=permissionProfileRequestGate.next();try{const result=await rpc('permissionProfile/list',{cwd:permissionProfileCwd(),limit:100});if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles(result.data||[])}catch{if(permissionProfileRequestGate.isCurrent(requestId))setPermissionProfiles([])}}
function permissionThreadPolicy(){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId};return{approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandbox:selected.sandbox}}
function permissionTurnPolicy(cwd){const selected=selectedPermission();if(selected.kind==='profile')return{permissions:selected.profileId,approvalPolicy:null,approvalsReviewer:null};const sandboxPolicy=selected.sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:cwd?[cwd]:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};return{permissions:null,approvalPolicy:selected.approvalPolicy,approvalsReviewer:selected.approvalsReviewer,sandboxPolicy}}
function renderPermissionMenu(){const list=$('#permissionOptions');if(!list)return;list.innerHTML='';const modes=['default'];if(autoReviewSupported())modes.push('guardian-approvals');if(state.permissionVisibility.fullAccess)modes.push('full-access');for(const profile of state.permissionProfiles)modes.push(`${PERMISSION_PROFILE_PREFIX}${profile.id}`);for(const mode of modes){const option=permissionModeDefinition(mode);if(!option)continue;const checked=mode===state.permissionMode,button=document.createElement('button');button.type='button';button.className='permission-option';button.dataset.permissionMode=mode;button.role='menuitemradio';button.disabled=option.allowed===false;button.setAttribute('aria-checked',String(checked));const description=option.allowed===false?'Not allowed by managed settings':option.description;button.innerHTML=`<span class="permission-option-icon">${codexIcon(option.icon)}</span><span class="permission-option-copy"><strong>${escapeHtml(option.optionLabel||option.label)}</strong><small>${escapeHtml(description)}</small></span><span class="permission-option-check">${checked?codexIcon('check'):''}</span>`;button.onclick=()=>choosePermissionMode(mode);list.append(button)}}
function syncPermissionSettings(){const autoRow=$('#settingsAutoReviewRow'),autoToggle=$('#settingsAutoReviewToggle'),fullToggle=$('#settingsFullAccessToggle');if(autoRow)autoRow.hidden=true;if(autoToggle)autoToggle.checked=autoReviewSupported();if(fullToggle)fullToggle.checked=state.permissionVisibility.fullAccess;syncTaskNotifySettings()}
const TASK_NOTIFY_STORAGE_KEY='codex-webui-task-notify';
function taskNotifyEnabled(){return localStorage.getItem(TASK_NOTIFY_STORAGE_KEY)!=='false'}
function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle');if(toggle)toggle.checked=taskNotifyEnabled()&&Notification.permission!=='denied'}
async function setTaskNotifyEnabled(enabled){const on=Boolean(enabled);localStorage.setItem(TASK_NOTIFY_STORAGE_KEY,String(on));if(on&&'Notification'in window&&Notification.permission==='default'){try{await Notification.requestPermission()}catch{}}syncTaskNotifySettings();if(on&&Notification.permission==='denied')toast(t('Browser notifications are blocked'))}
function maybeNotifyTaskCompleted(p){if(!taskNotifyEnabled())return;if(!('Notification'in window)||Notification.permission!=='granted')return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed');try{new Notification(t('Task completed'),{body:title,tag:`codex-turn-${p.turn?.id||Date.now()}`})}catch{}}
function requestTaskNotifyPermission(){if(taskNotifyEnabled()&&'Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{})}
function syncPermissionControl(){normalizePermissionMode();const selected=selectedPermission();$('#modeButton .control-label').textContent=t(state.planMode?'Plan mode':selected.label);$('#modeButton').classList.toggle('active',state.planMode||state.permissionMode!=='default');if($('#settingsPermissionValue'))$('#settingsPermissionValue').textContent=t(selected.label);syncPermissionSettings();renderPermissionMenu()}
function setPermissionMode(mode){if(!permissionModeAvailable(mode))return;const selected=permissionModeDefinition(mode);state.permissionMode=mode;localStorage.setItem('codex-webui-permission-mode',mode);syncPermissionControl();closePermissionMenu();toast(selected.label)}
function setPermissionVisibility(kind,enabled){state.permissionVisibility[kind]=Boolean(enabled);localStorage.setItem(kind==='autoReview'?'codex-webui-permission-auto-review':'codex-webui-permission-full-access',String(Boolean(enabled)));normalizePermissionMode();syncPermissionControl()}
function openPermissionMenu(){closeModelMenu();syncPermissionControl();$('#permissionMenu').hidden=false;$('#modeButton').setAttribute('aria-expanded','true')}
function closePermissionMenu(){const menu=$('#permissionMenu');menu.hidden=true;$('#modeButton').setAttribute('aria-expanded','false')}
function togglePermissionMenu(){if($('#permissionMenu').hidden)openPermissionMenu();else closePermissionMenu()}
function choosePermissionMode(mode){closePermissionMenu();if(mode==='full-access'&&state.permissionMode!=='full-access'){pendingFullAccessAction='select';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal();return}setPermissionMode(mode)}
async function loadFolders(path=folderBrowse.path){const list=$('#folderList');list.innerHTML='<div class="list-state">Loading folders…</div>';try{const response=await fetch(`/api/folders?path=${encodeURIComponent(path)}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Cannot browse folder');folderBrowse={path:data.path,parent:data.parent,selected:data.path};$('#folderPathInput').value=data.path;$('#folderSelection').textContent=data.path;$('#folderConfirm').disabled=false;$('#folderUp').disabled=!data.parent;list.innerHTML='';for(const folder of data.folders){const b=document.createElement('button');b.type='button';b.className='folder-item';b.innerHTML=`${icons.file}<span>${escapeHtml(folder.name)}</span>`;b.ondblclick=()=>loadFolders(folder.path);b.onclick=()=>{folderBrowse.selected=folder.path;$('#folderSelection').textContent=folder.path;$('#folderConfirm').disabled=false;list.querySelectorAll('.folder-item').forEach(x=>x.classList.remove('selected'));b.classList.add('selected')};list.append(b)}if(!data.folders.length)list.innerHTML='<div class="list-state">No subfolders</div>'}catch(e){list.innerHTML=`<div class="list-state">${escapeHtml(e.message)}</div>`}}
function openFolderPicker(){const dialog=$('#folderDialog');folderBrowse.selected=null;dialog.showModal();loadFolders(state.projectless?(state.config.defaultCwd||'~/projects'):($('#projectPath').textContent||'~/projects'));$('#projectlessOption').classList.toggle('selected',state.projectless)}
async function syncWorkspaceContext(path){const requestId=workspaceContextRequestGate.next();try{const response=await fetch(`/api/workspace/context?cwd=${encodeURIComponent(path)}`,{cache:'no-store'}),context=await response.json();if(!response.ok)throw new Error(context.error||'Workspace context unavailable');if(!workspaceContextRequestGate.isCurrent(requestId)||state.projectless)return;state.workspaceContext=context;if(!state.active)showEmpty()}catch{if(workspaceContextRequestGate.isCurrent(requestId)&&!state.projectless){state.workspaceContext={cwd:path,project:path.split('/').filter(Boolean).at(-1)||path,environment:'Local',branch:'No branch'};if(!state.active)showEmpty()}}}
function syncProjectControl(){const button=$('#composerProjectButton'),label=$('#composerProjectLabel');button.hidden=Boolean(state.active);label.textContent=state.projectless?'Tasks':($('#projectName').textContent||'Project')}
function refreshComposerPlaceholder(){const followUpType=state.active?(state.active.source==='cloud'?'cloud':'local'):undefined;$('#prompt').placeholder=resolveComposerPlaceholder({followUpType,composerMode:state.composerMode,cloudStartingState:state.cloudStartingState,isBackgroundSubagentsPanelVisible:state.backgroundAgentsVisible,isGoalModeActive:state.goalMode,isPlanModeActive:state.planMode,placeholderText:state.placeholderText,isHome:!state.active})}
function setWorkspace(path){const name=path.split('/').filter(Boolean).at(-1)||path,resolved=path.replace(/^~/,state.config.home);workspaceContextRequestGate.next();state.projectless=false;state.workspaceContext={cwd:resolved,project:name,environment:'Local',branch:null};$('#projectPath').textContent=shortPath(path);$('#projectName').textContent=name;localStorage.setItem('codex-webui-project',path);syncProjectControl();if(!state.active)showEmpty();if(!$('#summaryPanel').hidden)syncSummaryPanel();syncWorkspaceContext(resolved);if(state.connected)loadPermissionProfiles()}
function setProjectless(){workspaceContextRequestGate.next();state.projectless=true;state.workspaceContext=null;$('#projectPath').textContent='~';$('#projectName').textContent=t('Tasks');localStorage.setItem('codex-webui-project','~');syncProjectControl();if(!state.active){$('#threadPath').textContent='';showEmpty()}if(!$('#summaryPanel').hidden)syncSummaryPanel();if(state.connected)loadPermissionProfiles()}
function resetReviewState(){state.turnDiffs.clear();state.activeReview=null;reviewPatchState='undo';$('#reviewTab').hidden=true;if(!$('#reviewPanelContent').hidden)setSidePanelView('launcher','New tab');renderChanges()}
function clearConversationRuntime(){for(const animation of state.motion.values())animation?.destroy?.();state.items.clear();state.turns.clear();state.activities.clear();state.activityItems.clear();state.sideTasks.clear();state.dividers.clear();state.motion.clear();renderSideTasks()}
function rememberActiveThread(id){if(id)localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY,String(id));else localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY)}
function startNewTask(){saveComposerDraft();sessionClient.activate(null);openThreadGate.next();mobileNavigation?.showChat();if(mobileSidebarEnabled())setSidebarOpen(false);resetActiveThreadSync();setActiveTurnId('');rememberActiveThread(null);state.active=null;showUserInputDialog.setThread(null);for(const card of state.requestCards.values())card.remove();state.requestCards.clear();state.composerMentions=[];state.composerImages=[];state.composerMessageId='';renderQueuedMessages();state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();$('#threadTitle').textContent=t('New task');$('#threadPath').textContent=state.projectless?'':$('#projectPath').textContent;$('#prompt').value='';setPlanMode(false);syncProjectControl();renderContextTray();renderContextUsage();resizePrompt();if(!$('#summaryPanel').hidden)syncSummaryPanel();showEmpty();renderThreads();restoreComposerDraft(true);const owner=composerDraftOwner();drafts.load(owner).then(()=>{if(!state.active&&owner===composerDraftOwner())restoreComposerDraft()}).catch(()=>{});$('#prompt').focus()}
function useSelectedFolder(){if(!folderBrowse.selected)return;setWorkspace(folderBrowse.selected);$('#folderDialog').close();startNewTask()}
function useProjectless(){setProjectless();$('#folderDialog').close();startNewTask()}
function titleOf(t){return (t.name||t.preview||'Untitled task').replace(/\s+/g,' ').trim().slice(0,110)}
function shortPath(path=''){const home=state.config.home;return home&&path.startsWith(home)?'~'+path.slice(home.length):path}
function sidebarProjectKey(thread={}){return thread.projectless||!thread.cwd?'__tasks__':String(thread.cwd).replace(/\/+$/,'')}
function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key===state.config.home)return'Home';return key.split('/').filter(Boolean).at(-1)||key}
function currentSidebarProjectKey(){if(state.projectless)return'__tasks__';return String(state.active?.cwd||state.workspaceContext?.cwd||$('#projectPath').textContent||'').replace(/^~/,state.config.home).replace(/\/+$/,'')}
function saveSidebarProjectExpansion(){localStorage.setItem(SIDEBAR_PROJECT_EXPANSION_KEY,JSON.stringify(sidebarProjectExpansion))}
async function deleteThread(thread){
  if(!thread?.id)return;
  const title=titleOf(thread);
  if(!confirm(t('Delete “{title}”? This permanently deletes the thread and its descendants.',{title})))return;
  try{
    await rpc('thread/delete',{threadId:thread.id});
    const wasActive=state.active?.id===thread.id;
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    await refreshThreadList();
    if(wasActive)startNewTask();else renderThreads();
    toast(t('Thread deleted'));
  }catch(error){console.error('Could not delete thread',error);toast(t('Could not delete thread'))}
}
function startProjectTask(projectKey){
  if(projectKey==='__tasks__')setProjectless();else setWorkspace(projectKey);
  sidebarProjectExpansion[projectKey]=true;saveSidebarProjectExpansion();startNewTask();
  if(mobileSidebarEnabled())setSidebarOpen(false);
}
const threadStatusTypes=new Map(),unreadCompletedThreads=new Set();
function observeThreadStatus(threadId,status){
  const type=typeof status==='string'?status:status?.type;
  if(!type)return;
  if(type==='active')unreadCompletedThreads.delete(threadId);
  else if(type==='idle'&&threadStatusTypes.get(threadId)==='active')unreadCompletedThreads.add(threadId);
  threadStatusTypes.set(threadId,type);
}
function renderThreadStatus(indicator,status,threadId){
  const type=typeof status==='string'?status:status?.type,running=type==='active';
  const className='thread-status'+(running?' running':'');
  if(indicator.className!==className)indicator.className=className;
  indicator.hidden=!running&&!unreadCompletedThreads.has(threadId);
  indicator.setAttribute('role','img');
  indicator.setAttribute('aria-label',t(running?'In progress':'Completed'));
  indicator.title=indicator.getAttribute('aria-label');
}
function syncThreadStatus(threadId,status){
  observeThreadStatus(threadId,status);
  const thread=state.threads.find(thread=>thread.id===threadId);if(thread)thread.status=status;
  if(state.active?.id===threadId)state.active.status=status;
  for(const row of $('#threadList').querySelectorAll('.thread-item'))if(row.dataset.id===threadId)renderThreadStatus(row.querySelector('.thread-status'),status,threadId);
}
function renderThreads(){
  const list=$('#threadList'),q=$('#threadSearch').value.trim().toLowerCase(),groups=new Map,existingGroups=new Map([...list.querySelectorAll('.sidebar-project-group')].map(section=>[section.dataset.project,section]));for(const child of [...list.children])if(!child.classList.contains('sidebar-project-group'))child.remove();
  for(const thread of state.threads){if(q&&!titleOf(thread).toLowerCase().includes(q)&&!thread.cwd?.toLowerCase().includes(q))continue;const key=sidebarProjectKey(thread),group=groups.get(key)||{key,threads:[],recency:0};group.threads.push(thread);group.recency=Math.max(group.recency,Number(thread.recencyAt||thread.updatedAt)||0);groups.set(key,group)}
  const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort((a,b)=>(a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency));
  for(const group of ordered){const containsActive=group.threads.some(thread=>thread.id===state.active?.id),expanded=Boolean(q)||(Object.hasOwn(sidebarProjectExpansion,group.key)?sidebarProjectExpansion[group.key]:containsActive||group.key===currentKey),section=existingGroups.get(group.key)||document.createElement('section');existingGroups.delete(group.key);section.className='sidebar-project-group';section.dataset.project=group.key;const heading=section.querySelector('.sidebar-project-row')||document.createElement('button');heading.type='button';heading.className='sidebar-project-row';heading.setAttribute('aria-expanded',String(expanded));heading.title=group.key==='__tasks__'?t('Tasks'):shortPath(group.key);heading.innerHTML=`${codexIcon(group.key==='__tasks__'?'messageSquare':'folderOpen')}<span>${escapeHtml(sidebarProjectName(group.key))}</span>${codexIcon('chevronRight','sidebar-project-chevron')}`;const headingRow=section.querySelector('.sidebar-project-heading')||document.createElement('div');headingRow.className='sidebar-project-heading';
    const newChat=headingRow.querySelector('.sidebar-project-new')||document.createElement('button');newChat.type='button';newChat.className='sidebar-project-new';
    const newChatLabel=t('New chat in {project}',{project:sidebarProjectName(group.key)});newChat.title=newChatLabel;newChat.setAttribute('aria-label',newChatLabel);if(!newChat.firstChild)newChat.innerHTML=codexIcon('plus');
    newChat.onclick=()=>startProjectTask(group.key);if(!headingRow.parentElement){headingRow.append(heading,newChat);section.append(headingRow)}const oldThreads=section.querySelector('.sidebar-project-threads'),threads=oldThreads||document.createElement('div'),scrollTop=threads.scrollTop,existingRows=new Map([...threads.children].map(row=>[row.dataset.id,row]));threads.className='sidebar-project-threads'+(expanded?' expanded':'');threads.setAttribute('aria-hidden',String(!expanded));threads.style.setProperty('--sidebar-thread-count',String(group.threads.length));heading.onclick=()=>{const next=heading.getAttribute('aria-expanded')!=='true';sidebarProjectExpansion[group.key]=next;saveSidebarProjectExpansion();heading.setAttribute('aria-expanded',String(next));threads.setAttribute('aria-hidden',String(!next));threads.classList.toggle('expanded',next)};for(const [index,thread] of group.threads.entries()){const row=existingRows.get(thread.id)||document.createElement('div');existingRows.delete(thread.id);row.className='thread-item'+(state.active?.id===thread.id?' active':'');row.dataset.id=thread.id;row.title=[titleOf(thread),shortPath(thread.cwd)].filter(Boolean).join(' — ');row.setAttribute('role','button');row.tabIndex=0;const indicator=row.querySelector('.thread-status')||document.createElement('span');renderThreadStatus(indicator,thread.status,thread.id);const name=row.querySelector('.thread-name')||document.createElement('span');name.className='thread-name';name.textContent=titleOf(thread);const meta=row.querySelector('.thread-meta')||document.createElement('span');meta.className='thread-meta';const time=meta.querySelector('time')||document.createElement('time');time.textContent=formatAge(thread.recencyAt||thread.updatedAt);meta.append(time);const remove=row.querySelector('.thread-delete')||document.createElement('button');remove.type='button';remove.className='thread-delete';remove.title=t('Delete thread');remove.setAttribute('aria-label',t('Delete thread “{title}”',{title:titleOf(thread)}));remove.innerHTML=codexIcon('trash');remove.onkeydown=event=>event.stopPropagation();remove.onclick=event=>{event.stopPropagation();deleteThread(thread)};if(!indicator.parentElement)row.append(indicator,name,meta,remove);const open=()=>{if(mobileSidebarEnabled())setSidebarOpen(false);openThread(thread.id)};row.onclick=event=>{if(event.target.closest('.thread-delete'))return;open()};row.onkeydown=event=>{if(event.target.closest('.thread-delete'))return;if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}};if(threads.children[index]!==row){if(threads.moveBefore&&row.parentElement===threads)threads.moveBefore(row,threads.children[index]||null);else threads.insertBefore(row,threads.children[index]||null)}}for(const row of existingRows.values())row.remove();if(!oldThreads)section.append(threads);threads.scrollTop=scrollTop;const position=ordered.indexOf(group);if(list.children[position]!==section)list.insertBefore(section,list.children[position]||null)}
  for(const section of existingGroups.values())section.remove();
  if(!list.children.length)list.innerHTML='<div class="list-state">No matching tasks</div>';
}
async function openThread(id,fallbackSummary=null){
  unreadCompletedThreads.delete(id);
  saveComposerDraft();const revision=openThreadGate.next();mobileNavigation?.showChat();
  resetActiveThreadSync();setActiveTurnId('');
  state.active={...(state.threads.find(thread=>thread.id===id)||fallbackSummary||{}),id};rememberActiveThread(id);
  state.turnWindow=null;clearConversationRuntime();state.changes.clear();resetReviewState();closeComposerAutocomplete();
  serverRequests.clear();renderServerRequests();restoreComposerDraft(true);renderHeader();renderThreads();
  $('#conversation').innerHTML='<div class="list-state conversation-loading">Loading conversation…</div>';
  await sessionClient.activate(id,true);return openThreadGate.isCurrent(revision);
}

function renderHeader(){const t=state.active;if(!t)return;renderQueuedMessages();$('#threadTitle').textContent=titleOf(t);if(t.projectless){state.projectless=true;state.workspaceContext=null;$('#projectName').textContent='Tasks';$('#projectPath').textContent='~';$('#threadPath').textContent=''}else{$('#threadPath').textContent=shortPath(t.cwd);setWorkspace(t.cwd||state.config.home)}syncProjectControl();refreshComposerPlaceholder();$('#threadSource').textContent=t.source||'local'}
function renderThread(thread,loadMore=0){const root=$('#conversation'),turns=thread.turns||[];state.turnWindow=createTurnWindow(turns,DEFAULT_TURN_PAGE_SIZE,state.turnWindow?.threadId===thread.id?state.turnWindow.start:undefined,loadMore);state.turnWindow.threadId=thread.id;clearConversationRuntime();root.innerHTML='';if(state.turnWindow.hiddenCount){const more=document.createElement('button');more.className='load-older';more.textContent=`Load earlier messages (${state.turnWindow.hiddenCount})`;more.onclick=()=>renderThread(thread,DEFAULT_TURN_PAGE_SIZE);root.append(more)}for(const turn of state.turnWindow.visible)renderTurn(turn,root);renderServerRequests();if(!root.children.length)showEmpty();}
function showEmpty(){const root=$('#conversation'),project=state.projectless?null:(state.workspaceContext?.project||$('#projectName').textContent?.trim());root.innerHTML=`<div class="empty-state" id="emptyState">${codexInterfaceMark('empty-codex-mark')}<h1>${project?`What can I help with in ${escapeHtml(project)}?`:'What can I help?'}</h1></div>`}
function ensureTurnTimeline(turnId,root=$('#conversation')){let turn=state.turns.get(turnId);if(turn?.isConnected)return turn;turn=document.createElement('article');turn.className='turn assistant-turn native-turn-timeline';turn.dataset.turnId=turnId;turn.innerHTML='<div class="assistant-body"><div class="turn-event-stream"></div></div><div class="turn-final-slot"></div><div class="worked-for-divider" data-worked-for-divider data-i18n-ignore hidden><span></span></div>';root.append(turn);state.turns.set(turnId,turn);state.dividers.set(turnId,turn.querySelector('[data-worked-for-divider]'));return turn}
function turnDurationMs(turn={}){if(Number.isFinite(turn.durationMs))return turn.durationMs;if(Number.isFinite(turn.startedAt)&&Number.isFinite(turn.completedAt))return Math.max(0,(turn.completedAt-turn.startedAt)*1000);if(Number.isFinite(turn.startedAtMs)&&Number.isFinite(turn.completedAtMs))return Math.max(0,turn.completedAtMs-turn.startedAtMs);return undefined}
function syncWorkedForDivider(turnId,durationMs){
  const turn=state.turns.get(turnId),divider=state.dividers.get(turnId);if(!turn||!divider)return;
  if(Number.isFinite(durationMs))turn.dataset.durationMs=String(durationMs);
  const active=turn.dataset.timingStatus==='inProgress',started=Number(turn.dataset.startedAtMs),completed=Number(turn.dataset.completedAtMs);
  const duration=active?Date.now()-started:Number(turn.dataset.durationMs);
  divider.hidden=!Number.isFinite(duration);if(divider.hidden)return;
  const seconds=Math.max(0,Math.floor(duration/1000)),elapsed=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
  const time=Number.isFinite(completed)?new Date(completed).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}):'';
  divider.querySelector('span').textContent=active?`Working for ${elapsed}`:`Worked for ${elapsed}${time?` • ${time}`:''}`;
}
function syncTurnTiming(turn,root=$('#conversation')){
  if(!turn?.id)return;
  const node=ensureTurnTimeline(turn.id,root),active=turn.status==='inProgress';
  node.dataset.timingStatus=turn.status||'completed';
  const started=Number.isFinite(turn.startedAtMs)?turn.startedAtMs:Number.isFinite(turn.startedAt)?turn.startedAt*1000:undefined;
  const completed=Number.isFinite(turn.completedAtMs)?turn.completedAtMs:Number.isFinite(turn.completedAt)?turn.completedAt*1000:undefined;
  if(Number.isFinite(started))node.dataset.startedAtMs=String(started);
  else if(active&&!node.dataset.startedAtMs)node.dataset.startedAtMs=String(Date.now());
  if(!active&&(Number.isFinite(completed)||node.dataset.startedAtMs))node.dataset.completedAtMs=String(completed??Number(node.dataset.completedAtMs||Date.now()));
  const duration=turnDurationMs(turn)??(!active&&node.dataset.startedAtMs?Number(node.dataset.completedAtMs)-Number(node.dataset.startedAtMs):undefined);
  syncWorkedForDivider(turn.id,duration);
}
setInterval(()=>{for(const[id,node]of state.turns)if(node.isConnected&&node.dataset.timingStatus==='inProgress')syncWorkedForDivider(id)},1000);
function renderTurn(turn,root=$('#conversation')){
  for(const item of turn.items||[])upsertItem(item,turn.id,root,false);
  syncTurnTiming(turn,root);
  const timeline=state.turns.get(turn.id),stream=timeline.querySelector('.turn-event-stream'),ordered=[],seen=new Set();
  let first=true;
  for(const item of turn.items||[]){
    let node=state.items.get(item.id);
    if(!node)node=timeline.querySelector(`[data-item-id="${CSS.escape(String(item.id))}"]`)?.closest('[data-agent-activity-group]');
    if(!node)continue;
    if(first&&item.type==='userMessage'){root.insertBefore(node,timeline);first=false;continue}
    first=false;
    if(node.parentElement===timeline.querySelector('.turn-final-slot'))continue;
    if(!seen.has(node)){seen.add(node);ordered.push(node)}
  }
  // Reconcile snapshots in log order; local pending messages remain at the end.
  let anchor=stream.firstChild;for(const node of ordered){if(node!==anchor)stream.insertBefore(node,anchor);anchor=node.nextSibling}
  timeline._snapshot=structuredClone(turn);
}
function textFromInput(content=[]){return content.filter(x=>x.type==='text').map(x=>x.text).join('\n')}
function claimOptimisticUser(item,root){if(String(item.id).startsWith('local-'))return null;const text=textFromInput(item.content),candidates=[...root.querySelectorAll('.user-turn[data-optimistic-user="true"]')];const el=candidates.find(node=>node.querySelector('.user-message')?.textContent===text);if(!el)return null;for(const[id,node]of state.items)if(node===el)state.items.delete(id);delete el.dataset.optimisticUser;state.items.set(item.id,el);return el}
function agentMessageIdFamily(id){const value=String(id||'');return /^item[-_]/.test(value)?'app':/^(?:msg_|host-message-)/.test(value)?'rollout':''}
function userMessageSource(id){return String(id).startsWith('host-user-')?'userRolloutId':String(id).startsWith('host-sent-')?'userSentId':'userNativeId'}
function claimEquivalentUserMessage(item,turnId){const source=userMessageSource(item.id),text=textFromInput(item.content).trim();for(const node of state.items.values()){const pending=node.dataset.pendingMessageId&&!node.dataset.userTurnId;if(!node.isConnected||node.dataset.userTurnId!==turnId&&!pending||node.dataset.userText!==text||node.dataset[source])continue;state.items.set(item.id,node);return node}return null}
function claimEquivalentAgentMessage(item,turnId){const family=agentMessageIdFamily(item.id);if(!family)return null;const text=agentMessageText(item,''),commentary=item.phase==='commentary';for(const[id,node]of state.items){if(agentMessageIdFamily(id)===family||node.closest('[data-turn-id]')?.dataset.turnId!==turnId)continue;const body=node.querySelector('.message-text'),existingCommentary=node.dataset.localConversationCommentary!==undefined;if(existingCommentary===commentary&&body?.dataset.raw===text){state.items.set(item.id,node);return node}}return null}
function placeAgentMessage(el,item,timeline){const commentary=item.phase==='commentary',slot=timeline.querySelector(commentary?'.turn-event-stream':'.turn-final-slot');el.className=commentary?'assistant-response assistant-commentary':'assistant-response';if(commentary){delete el.dataset.localConversationFinalAssistant;el.dataset.localConversationCommentary=''}else{delete el.dataset.localConversationCommentary;el.dataset.localConversationFinalAssistant=''}if(el.parentElement!==slot)slot.append(el)}
function imageCwd(item={}){return item.cwd||state.active?.cwd||state.config.defaultCwd||'.'}
function sideTaskStatus(item,threadId){const agent=item.agentsStates?.[threadId];if(agent?.status)return agent.status;if(item.type==='subAgentActivity')return item.kind==='interrupted'?'interrupted':'running';return item.status==='failed'?'errored':item.status==='completed'?'completed':'running'}
function updateSideTasks(item){if(item.type==='collabAgentToolCall'){for(const threadId of item.receiverThreadIds||[]){const previous=state.sideTasks.get(threadId)||{};state.sideTasks.set(threadId,{...previous,threadId,prompt:item.prompt||previous.prompt||'',model:item.model||previous.model||'',reasoningEffort:item.reasoningEffort||previous.reasoningEffort||'',status:sideTaskStatus(item,threadId),message:item.agentsStates?.[threadId]?.message||previous.message||''})}}else if(item.type==='subAgentActivity'){const previous=state.sideTasks.get(item.agentThreadId)||{};state.sideTasks.set(item.agentThreadId,{...previous,threadId:item.agentThreadId,agentPath:item.agentPath||previous.agentPath||'',status:sideTaskStatus(item,item.agentThreadId)})}renderSideTasks()}
function renderSideTasks(){const list=$('#sideTaskList');if(!list)return;list.innerHTML='';for(const task of state.sideTasks.values()){const button=document.createElement('button');button.type='button';button.className='side-task-card';button.dataset.threadId=task.threadId;button.innerHTML=`${codexIcon('messageSquare')}<span class="side-task-copy"><strong>${escapeHtml(task.agentPath||task.model||'Side task')}</strong><small>${escapeHtml(task.message||task.prompt||task.threadId)}</small></span><span class="side-task-status ${escapeHtml(task.status||'running')}">${escapeHtml(task.status||'running')}</span>`;button.onclick=async()=>{button.disabled=true;button.setAttribute('aria-busy','true');await openThread(task.threadId,{id:task.threadId,name:task.agentPath||task.model||'Side task',preview:task.prompt||task.message||'',cwd:state.active?.cwd||state.config.defaultCwd,source:'local',sideTask:true});if(button.isConnected){button.disabled=false;button.removeAttribute('aria-busy')}};list.append(button)}if(!state.sideTasks.size)list.innerHTML='<div class="side-task-empty">Side tasks started by this chat will appear here.</div>';const summary=$('#summarySideTasks');if(summary)summary.textContent=state.sideTasks.size?`${state.sideTasks.size} side task${state.sideTasks.size===1?'':'s'}`:'No side tasks'}
function upsertItem(item,turnId,root=$('#conversation'),live=true){
  root.querySelector('#emptyState')?.remove();
  let el=state.items.get(item.id);
  if(el?.dataset.pendingMessageId&&turnId&&item.type==='userMessage'){
    const equivalent=claimEquivalentUserMessage(item,turnId);
    if(equivalent&&equivalent!==el){for(const[id,node]of state.items)if(node===el)state.items.set(id,equivalent);el.remove();el=equivalent}
  }
  if(!el&&item.type==='userMessage')el=claimOptimisticUser(item,root)||claimEquivalentUserMessage(item,turnId);if(!el&&item.type==='agentMessage')el=claimEquivalentAgentMessage(item,turnId);if(!el){
    if(item.type==='userMessage'){el=document.createElement('article');el.className='turn user-turn';if(String(item.id).startsWith('local-'))el.dataset.optimisticUser='true';el.innerHTML='<div class="user-message"></div>';const timeline=state.turns.get(turnId);timeline?.isConnected?timeline.querySelector('.turn-event-stream').append(el):root.append(el)}
    else if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.innerHTML='<div class="message-text"></div>';placeAgentMessage(el,item,timeline)}
    else if(item.type==='imageGeneration'){const timeline=ensureTurnTimeline(turnId,root);el=document.createElement('div');el.className='assistant-generated-image';timeline.querySelector('.turn-event-stream').append(el)}
    else if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','subAgentActivity','webSearch','reasoning','plan','imageView'].includes(item.type)){const id=activityItemId(item);el=ensureActivity(turnId,root,id,item.type==='imageView'||item.type==='reasoning');addActivity(item,el,id)}
    else return;
    if(item.type==='userMessage'||item.type==='agentMessage'||item.type==='imageGeneration')state.items.set(item.id,el);
  }
  if(item.type==='userMessage'){
    const source=userMessageSource(item.id),previousTurnId=el.dataset.userTurnId;
    el.dataset.userTurnId=turnId||previousTurnId||'';el.dataset.userText=textFromInput(item.content).trim();el.dataset[source]=item.id;
    if(turnId){delete el.dataset.pendingMessageId;const timeline=state.turns.get(turnId);if(previousTurnId!==turnId&&timeline?.isConnected)timeline.querySelector('.turn-event-stream').append(el)}
    if(source==='userNativeId'||!el.dataset.userNativeId&&(source==='userSentId'||!el.dataset.userSentId)){const body=el.querySelector('.user-message');body.textContent=textFromInput(item.content);body.insertAdjacentHTML('beforeend',renderItemImages(item,{cwd:imageCwd(item)}))}
  }
  if(item.type==='agentMessage'){const timeline=ensureTurnTimeline(turnId,root),body=el.querySelector('.message-text'),text=agentMessageText(item,body.dataset.raw??''),cwd=imageCwd(item);placeAgentMessage(el,item,timeline);body.dataset.raw=text;body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text});syncWorkedForDivider(turnId)}
  if(item.type==='imageGeneration'){const html=renderItemImages(item,{cwd:imageCwd(item),className:'generated-image-grid'});el.innerHTML=html||`<div class="generated-image-pending ${item.status==='inProgress'?'loading-shimmer':''}">${item.status==='failed'?'Image generation failed':'Generating image'}</div>`}
  if(item.type==='fileChange'){for(const ch of item.changes||[]){const path=ch.path||ch.filePath||'Changed file';state.changes.set(path,ch)}syncTurnReviewFromItems(turnId);renderChanges()}
  if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity')updateSideTasks(item)
  if(live)scrollBottom();
}
function activityGroupExpansionKey(activity){const threadId=state.active?.id,turnId=activity.closest('[data-turn-id]')?.dataset.turnId,anchor=activity.dataset.activityGroupAnchor;return threadId&&turnId&&anchor?`codex-webui-activity-group:${threadId}:${turnId}:${anchor}`:null}
function savedActivityGroupExpansion(activity){const key=activityGroupExpansionKey(activity),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityGroupOpen(activity,open,persist=false){const button=activity.querySelector('.activity-summary'),items=activity.querySelector('.activity-items');button.classList.toggle('open',open);items.classList.toggle('open',open);if(persist&&!activity.classList.contains('single')){const key=activityGroupExpansionKey(activity);if(key)localStorage.setItem(key,open?'open':'closed')}}
function ensureActivity(turnId,root,itemId,standalone=false){const turn=ensureTurnTimeline(turnId,root),stream=turn.querySelector('.turn-event-stream'),existing=itemId?turn.querySelector(`[data-item-id="${CSS.escape(String(itemId))}"]`)?.closest('[data-agent-activity-group]'):null;if(existing)return existing;let activity=standalone?null:state.activities.get(turnId);if(!activity?.isConnected||activity.parentElement!==stream||stream.lastElementChild!==activity||activity.dataset.standalone==='true'){activity=document.createElement('div');activity.className='activity-group active';activity.dataset.agentActivityGroup='';activity.dataset.activityGroupAnchor=String(itemId||'activity');if(standalone)activity.dataset.standalone='true';activity.innerHTML=`<button class="activity-summary open"><span class="activity-summary-icon" aria-hidden="true"></span><span class="activity-summary-copy loading-shimmer">Working</span>${icons.chevron}</button><div class="activity-items open"></div>`;activity.querySelector('.activity-summary').onclick=()=>setActivityGroupOpen(activity,!activity.querySelector('.activity-summary').classList.contains('open'),true);stream.append(activity);state.activities.set(turnId,activity)}if(!state.activityItems.has(turnId))state.activityItems.set(turnId,new Map);return activity}
function joinActivityText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.filter(part=>typeof part==='string').join('\n');return''}
function activityOutput(item){if(item.type==='reasoning')return joinActivityText(item.summary)||joinActivityText(item.content);const output=item.aggregatedOutput??item.output?.aggregatedOutput??item.output;if(typeof output==='string')return output;if(Array.isArray(output))return output.join('\n');return joinActivityText(item.content)||(item.result?JSON.stringify(item.result,null,2):'')}
function commandText(item){return item.command||(item.commandActions||[]).map(action=>action?.command).filter(Boolean).join('\n')||''}
function commandExitCode(item){return item.exitCode??item.output?.exitCode}
function commandFooter(item,data){if(data.active)return{label:'',icon:''};if(item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled')return{label:'Stopped',icon:''};const exitCode=commandExitCode(item);if(data.tone==='error')return{label:exitCode==null?'Failed':`Exit code ${exitCode}`,icon:''};return{label:'Success',icon:icons.check}}
function renderCommandShell(out,item,data){if(out.dataset.outputKind!=='command'){out.dataset.outputKind='command';out.className='activity-output command-shell-wrap';out.innerHTML='<div class="command-shell"><div class="command-shell-body"><div class="command-shell-command"><span aria-hidden="true">$</span><code></code></div><div class="command-shell-output"><pre></pre></div></div><div class="command-shell-footer"></div></div>'}const output=activityOutput(item),pre=out.querySelector('.command-shell-output pre'),footer=commandFooter(item,data);out.querySelector('.command-shell-command code').textContent=commandText(item);pre.textContent=output||(data.active?'':'No output');pre.classList.toggle('empty',!output);out.querySelector('.command-shell-footer').innerHTML=`${footer.icon}<span>${footer.label}</span>`}
function inlineFileChangeDiff(change){const raw=unifiedDiffFromFileChanges([change]),review=parseUnifiedDiff(raw);if(!review.hasChanges){const diff=change.diff||change.unified_diff||'';return diff?`<pre>${escapeHtml(diff)}</pre>`:''}return `<div class="file-change-inline-diff">${review.files.flatMap(file=>file.hunks.map(hunk=>`<div class="file-change-inline-hunk"><div class="review-hunk-head">${escapeHtml(hunk.header)}</div><div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div></div>`)).join('')}</div>`}
function renderFileChangeOutput(out,item,data){out.dataset.outputKind='file-change';out.className='activity-output file-change-output';const changes=item.changes||[],legacy=activityOutput(item);if(!changes.length){out.innerHTML=`<div class="file-change-progress ${data.active?'loading-shimmer':''}">${escapeHtml(legacy||(data.active?'Waiting for patch details…':'No patch details'))}</div>`;return}out.innerHTML=changes.map(change=>{const path=change.path||change.filePath||'Changed file',kind=typeof change.kind==='string'?change.kind:change.kind?.type||'update';return `<section class="file-change-output-item"><div class="file-change-output-head">${codexIcon('fileDiff')}<span>${escapeHtml(shortPath(path))}</span><small>${escapeHtml(kind)}</small></div>${inlineFileChangeDiff(change)}</section>`}).join('')}
function isExplorationActivity(item,data=summarizeActivity(item)){return item.type==='commandExecution'&&['read','search','list'].includes(data.category)}
function renderActivityOutput(out,item,data){if(item.type==='imageView'){out.dataset.outputKind='image';out.className='activity-output activity-image-output';out.innerHTML=renderItemImages(item,{cwd:imageCwd(item),className:'activity-image-grid'})||'<div class="message-image-unavailable" data-i18n-ui>Image unavailable</div>';return}if(item.type==='commandExecution'&&data.category==='command'){renderCommandShell(out,item,data);return}if(item.type==='fileChange'){renderFileChangeOutput(out,item,data);return}if(item.type==='reasoning'){const text=activityOutput(item);out.dataset.outputKind='reasoning';out.className='activity-output reasoning-output message-text';out.innerHTML=text?renderAssistantMarkdown(text,{cwd:imageCwd(item)}):'';return}out.dataset.outputKind='plain';out.className='activity-output';out.textContent=isExplorationActivity(item,data)?'':activityOutput(item)||''}
function activityItemExpansionKey(row){const threadId=state.active?.id,turnId=row.closest('[data-turn-id]')?.dataset.turnId,itemId=row.dataset.itemId;return threadId&&turnId&&itemId?`codex-webui-activity-item:${threadId}:${turnId}:${itemId}`:null}
function savedActivityItemExpansion(row){const key=activityItemExpansionKey(row),saved=key&&localStorage.getItem(key);return saved==='open'?true:saved==='closed'?false:null}
function setActivityExpanded(row,expanded,persist=false){row.classList.toggle('expanded',expanded);row.setAttribute('aria-expanded',String(expanded));if(persist){const key=activityItemExpansionKey(row);if(key)localStorage.setItem(key,expanded?'open':'closed')}}
function motionIcon(name){return `<span class="activity-motion" data-animation="${name}"></span>`}
async function mountMotion(row,name){const holder=row.querySelector('.activity-motion');if(!holder)return;state.motion.get(row)?.destroy();try{const animationData=await fetch(`/assets/codex-motion/${name}.json`).then(r=>r.json());if(!holder.isConnected)return;const animation=lottie.loadAnimation({container:holder,renderer:'svg',loop:true,autoplay:true,animationData,rendererSettings:{preserveAspectRatio:'xMidYMid meet'}});state.motion.set(row,animation)}catch{holder.innerHTML=codexIcon('loaderCircle','motion-fallback')}}
function activityIconName(item,data=summarizeActivity(item)){if(item.type==='reasoning')return null;if(data.tone==='error')return'triangleAlert';if(item.type==='fileChange')return'fileDiff';if(data.category==='image')return'image';if(data.category==='read')return'file';if(data.category==='search'||item.type==='webSearch')return'search';if(data.category==='list')return'list';if(data.category==='command')return'terminal';return'wrench'}
function stopMotion(row,tone){const animation=state.motion.get(row);animation?.destroy();state.motion.delete(row);const holder=row.querySelector('.activity-motion'),turnId=row.closest('[data-turn-id]')?.dataset.turnId,item=state.activityItems.get(turnId)?.get(row.dataset.itemId),data=item?summarizeActivity(item):{tone};if(!holder)return;const icon=activityIconName(item||{},data);holder.innerHTML=icon?codexIcon(icon):''}
function activityItemId(item){return String(item.id||item.callId||item.requestId||`${item.type}-${Date.now()}`)}
function joinActivityParts(parts){return parts.length<2?parts[0]||'Worked':`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}
function completedActivitySummary(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),commands=summaries.filter(({item,data})=>item.type==='commandExecution'&&data.category==='command').length,explored=summaries.some(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error'),edits=summaries.filter(({item,data})=>item.type==='fileChange'&&data.tone!=='error').reduce((count,{item})=>count+Math.max(1,item.changes?.length||0),0),web=summaries.some(({item,data})=>item.type==='webSearch'&&data.tone!=='error'),images=summaries.some(({data})=>data.category==='image'&&data.tone!=='error'),failed=summaries.some(({data})=>data.tone==='error'),parts=[],add=(leading,following)=>parts.push(parts.length?following:leading);if(edits)add(edits===1?'Edited a file':'Edited files',edits===1?'edited a file':'edited files');if(explored)add('Read files','read files');if(commands)add(commands===1?'Ran a command':'Ran commands',commands===1?'ran a command':'ran commands');if(web)add('Searched the web','searched the web');if(images)add('Viewed images','viewed images');if(!parts.length&&failed)return'Activity failed';return joinActivityParts(parts)}
function completedActivityPrimaryItem(items){const summaries=items.map(item=>({item,data:summarizeActivity(item)})),find=predicate=>summaries.find(predicate)?.item;return find(({item,data})=>item.type==='fileChange'&&data.tone!=='error')||find(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error')||find(({data})=>data.category==='command'&&data.tone!=='error')||find(({item,data})=>item.type==='webSearch'&&data.tone!=='error')||find(({data})=>data.category==='image'&&data.tone!=='error')||items.find(item=>summarizeActivity(item).tone==='error')||items[0]}
function setActivitySummaryIcon(activity,item){const holder=activity.querySelector('.activity-summary-icon'),icon=item&&activityIconName(item);if(holder){holder.hidden=!icon;holder.innerHTML=icon?codexIcon(icon):''}}
function commandRowSummary(item,data,expanded){if(data.active)return data.label;const interrupted=item.executionStatus==='interrupted'||item.status==='interrupted'||item.status==='cancelled',command=commandText(item);if(expanded)return interrupted?'Stopped command':'Ran command';return`${interrupted?'Stopped':'Ran'}${command?` ${command}`:' command'}`}
function updateCommandRowSummary(row,item,data,expanded=row.classList.contains('expanded')){const summary=row.querySelector('.activity-name');if(summary)summary.textContent=commandRowSummary(item,data,expanded)}
function updateActivitySummary(activity){const turn=activity.closest('[data-turn-id]'),turnId=turn?.dataset.turnId,allItems=state.activityItems.get(turnId),rows=[...activity.querySelectorAll('.activity-item')],items=rows.map(row=>allItems?.get(row.dataset.itemId)).filter(Boolean),summary=activity.querySelector('.activity-summary-copy');if(!turn||!summary)return;activity.classList.toggle('single',items.length===1);const activeItem=items.findLast?.(item=>summarizeActivity(item).active)||[...items].reverse().find(item=>summarizeActivity(item).active),savedOpen=savedActivityGroupExpansion(activity);if(activeItem){const data=summarizeActivity(activeItem);setActivitySummaryIcon(activity,activeItem);summary.textContent=data.label;summary.classList.add('loading-shimmer');activity.classList.add('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??true))}else{setActivitySummaryIcon(activity,completedActivityPrimaryItem(items));summary.textContent=completedActivitySummary(items);summary.classList.remove('loading-shimmer');activity.classList.remove('active');setActivityGroupOpen(activity,items.length===1||(savedOpen??false))}syncWorkedForDivider(turnId)}
function addActivity(item,activity,id=activityItemId(item)){const data=summarizeActivity(item),turn=activity.closest('[data-turn-id]'),turnId=turn.dataset.turnId,items=state.activityItems.get(turnId)||new Map,box=activity.querySelector('.activity-items');items.set(id,item);state.activityItems.set(turnId,items);let row=box.querySelector(`[data-item-id="${CSS.escape(id)}"]`);if(!row){row=document.createElement('div');row.className='activity-item entering';row.dataset.itemId=id;box.append(row);const out=document.createElement('div');out.className='activity-output';box.append(out)}const imageView=item.type==='imageView',reasoning=item.type==='reasoning',command=item.type==='commandExecution'&&data.category==='command',fileChange=item.type==='fileChange',wasActive=row.dataset.activityWasActive==='true',savedExpanded=savedActivityItemExpansion(row),existingExpanded=row.dataset.expansionInitialized?row.classList.contains('expanded'):imageView,expanded=reasoning?(data.active?true:wasActive?false:(savedExpanded??existingExpanded)):(savedExpanded??existingExpanded);row.dataset.expansionInitialized='true';row.dataset.activityWasActive=String(data.active);row.className=`activity-item ${command?'command-activity ':''}${reasoning?'reasoning-activity ':''}${imageView?'image-activity ':''}${fileChange?'file-change-activity ':''}${data.active?'active':'settled'} ${data.tone}`;if(command){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<span class="activity-command-icon">${icons.terminal}</span><div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(commandRowSummary(item,data,expanded))}</div></div><span class="activity-command-chevron">${icons.chevron}</span>`}else if(reasoning){state.motion.get(row)?.destroy();state.motion.delete(row);row.innerHTML=`<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}">${escapeHtml(data.label)}</div></div><span class="activity-reasoning-chevron">${icons.chevron}</span>`}else{const detail=shortPath(data.detail||'');row.innerHTML=`${motionIcon(data.animation)}<div class="activity-copy"><div class="activity-name ${data.active?'loading-shimmer':''}"><span class="activity-label">${escapeHtml(data.label)}</span>${detail?` <span class="activity-detail">${escapeHtml(detail)}</span>`:''}</div></div><span class="activity-result">${fileChange?icons.chevron:''}</span>`}const out=row.nextElementSibling;renderActivityOutput(out,item,data);const reasoningOutput=reasoning&&!!activityOutput(item),expandable=imageView||command||fileChange||(reasoning&&!data.active&&reasoningOutput)||(!reasoning&&!isExplorationActivity(item,data)&&!!activityOutput(item));if(reasoning&&data.active&&reasoningOutput){row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.add('expanded')}else if(expandable){row.setAttribute('role','button');row.tabIndex=0;setActivityExpanded(row,expanded)}else{row.removeAttribute('role');row.removeAttribute('aria-expanded');row.tabIndex=-1;row.classList.remove('expanded')}row.onclick=expandable?()=>{const next=!row.classList.contains('expanded');setActivityExpanded(row,next,true);if(command)updateCommandRowSummary(row,item,data,next)}:null;row.onkeydown=expandable?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click()}}:null;if(!command&&!reasoning){if(data.active)mountMotion(row,data.animation);else stopMotion(row,data.tone)}updateActivitySummary(activity)}
function diffForTurn(turnId){return state.turnDiffs.get(turnId)||null}
function recordTurnReview(turnId,raw,source='fileChange'){if(!turnId||!raw)return null;const existing=state.turnDiffs.get(turnId);if(source!=='native'&&existing?.source==='native')return existing;const review=parseUnifiedDiff(raw);if(!review.hasChanges)return null;review.turnId=turnId;review.raw=raw;review.source=source;state.turnDiffs.set(turnId,review);state.activeReview=review;$('#reviewTab').hidden=false;renderChanges();return review}
function syncTurnReviewFromItems(turnId){const items=state.activityItems.get(turnId),changes=items?[...items.values()].flatMap(item=>item?.type==='fileChange'&&Array.isArray(item.changes)?item.changes:[]):[],raw=unifiedDiffFromFileChanges(changes);if(raw)recordTurnReview(turnId,raw)}
function saveReviewPreferences(){localStorage.setItem('codex-webui-review-preferences',JSON.stringify(reviewPreferences))}
function reviewLineHtml(line){if(!line)return '<div class="review-line empty"><span class="review-sign"></span><code></code></div>';return `<div class="review-line ${line.type}"><span class="review-sign">${line.type==='add'?'+':line.type==='delete'?'−':' '}</span><code>${escapeHtml(line.text)}</code></div>`}
function reviewHunkHtml(hunk){if(reviewPreferences.mode==='split'){return `<div class="review-split-lines">${splitDiffHunk(hunk).map(row=>`<div class="review-split-row"><div class="review-side old">${reviewLineHtml(row.left)}</div><div class="review-side new">${reviewLineHtml(row.right)}</div></div>`).join('')}</div>`}return `<div class="review-lines">${hunk.lines.map(reviewLineHtml).join('')}</div>`}
function syncReviewControls(review){const has=!!review?.hasChanges;$('#reviewMode').disabled=!has;$('#reviewWrap').disabled=!has;$('#reviewExpand').disabled=!has;$('#reviewPatch').disabled=!has||!state.active?.id||!review?.turnId;$('#reviewMode').title=reviewPreferences.mode==='unified'?'Switch to split diff':'Switch to unified diff';$('#reviewWrap').title=reviewPreferences.wrap?'Disable word wrap':'Enable word wrap';$('#reviewExpand').title=reviewPreferences.expanded?'Collapse all diffs':'Expand all diffs';$('#reviewPatch').title=reviewPatchState==='undo'?'Undo changes':'Reapply changes';$('#reviewPatch').innerHTML=codexIcon(reviewPatchState==='undo'?'undo':'redo')}
function renderChanges(){const list=$('#changeList'),review=state.activeReview||[...state.turnDiffs.values()].at(-1)||null,reviewVisible=document.body.classList.contains('side-panel-open')&&!$('#reviewPanelContent').hidden;document.body.classList.toggle('review-split-open',reviewVisible&&reviewPreferences.mode==='split'&&!!review?.hasChanges&&innerWidth>1200);list.dataset.mode=reviewPreferences.mode;list.classList.toggle('wrap',reviewPreferences.wrap);if(review?.hasChanges){$('#changeCount').textContent=review.fileCount;$('#changeSummary').textContent=`${review.fileCount} changed file${review.fileCount===1?'':'s'}`;$('#reviewStats').innerHTML=`<span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span>`;list.innerHTML='';for(const file of review.files){const section=document.createElement('section');section.className='review-file';section.dataset.path=file.path;section.innerHTML=`<button class="review-file-head" aria-expanded="${reviewPreferences.expanded}">${codexIcon('chevronDown','review-chevron')}<span class="review-file-name">${escapeHtml(shortPath(file.path))}</span><span class="review-file-stats"><span class="plus">+${file.linesAdded}</span><span class="minus">−${file.linesDeleted}</span></span></button><div class="review-hunks"${reviewPreferences.expanded?'':' hidden'}></div>`;const body=section.querySelector('.review-hunks');for(const hunk of file.hunks){const h=document.createElement('div');h.className='review-hunk';h.innerHTML=`<div class="review-hunk-head">${escapeHtml(hunk.header)}</div>${reviewHunkHtml(hunk)}`;body.append(h)}section.querySelector('.review-file-head').onclick=e=>{const open=e.currentTarget.getAttribute('aria-expanded')==='true';e.currentTarget.setAttribute('aria-expanded',String(!open));body.hidden=open};list.append(section)}syncReviewControls(review);return}$('#reviewStats').textContent='';$('#changeCount').textContent=state.changes.size;$('#changeSummary').textContent=state.changes.size?`${state.changes.size} changed file${state.changes.size===1?'':'s'}`:'No changes yet';list.innerHTML='';for(const [path,ch] of state.changes){const el=document.createElement('div');el.className='change-item';el.innerHTML=`<div class="change-path">${icons.file}<span>${escapeHtml(shortPath(path))}</span></div><div class="change-stats"><span class="plus">+${ch.additions||0}</span> <span class="minus">−${ch.deletions||0}</span></div>`;list.append(el)}if(!state.changes.size)list.innerHTML='<div class="panel-empty">Changes made by Codex will appear here.</div>';syncReviewControls(null)}
async function applyActiveReviewPatch(){const review=state.activeReview;if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');button.disabled=true;button.innerHTML=codexIcon('loaderCircle','review-loading');try{const response=await fetch('/api/review/patch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:state.active.id,turnId:review.turnId,action})}),result=await response.json();if(!response.ok)throw new Error(result.error||'Review patch failed');reviewPatchState=action==='undo'?'reapply':'undo';toast(action==='undo'?'Changes reverted':'Changes reapplied')}catch(error){toast(error.message)}finally{syncReviewControls(review)}}
function applyTerminalInteraction(p){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId);if(current?.type!=='commandExecution')return;let buffer=current.terminalInputBuffer||'',commands=[];for(const char of String(p.stdin||'')){if(char==='\r'||char==='\n'){const command=buffer.trim();if(command)commands.push(command);buffer='';continue}if(char==='\u0003'){buffer='';continue}if(char==='\b'||char==='\u007f'){buffer=buffer.slice(0,-1);continue}buffer+=char}const actions=[...(current.commandActions||[]),...commands.map(command=>({type:'unknown',command}))];upsertItem({...current,status:'inProgress',terminalInputBuffer:buffer,commandActions:actions},p.turnId)}

function onNotification(method,p){
  if(method==='serverRequest/resolved'){resolveServerRequest(p.requestId);return}
  if(method==='turn/completed'){
    for(const[id,request]of serverRequests)if(request.params?.threadId===p.threadId&&request.params?.turnId===p.turn?.id)resolveServerRequest(id);
  }
  if(method.startsWith('item/')||method.startsWith('turn/')||method==='error'){
    if(!state.active)return;
    if(p.threadId?p.threadId!==state.active.id:!p.turnId||!state.turns.has(p.turnId))return;
  }
  if(method==='account/updated')loadAccount(true);
  else if(method==='thread/started'){state.threads.unshift(p.thread);renderThreads()}
  else if(method==='thread/name/updated'){const t=state.threads.find(x=>x.id===p.threadId);if(t)t.name=p.name;renderThreads();renderHeader()}
  else if(method==='turn/started'){if(!p.threadId||p.threadId===state.active?.id){setActiveTurnId(p.turn?.id||'');syncTurnTiming({...p.turn,status:'inProgress'});scrollBottom()}scheduleActiveThreadSync(0)}
  else if(method==='item/started')upsertItem({...p.item,status:'inProgress'},p.turnId);
  else if(method==='item/completed'){const status=['failed','declined','interrupted','cancelled','canceled'].includes(p.item?.status)?p.item.status:'completed';upsertItem({...p.item,status},p.turnId)}
  else if(method==='item/agentMessage/delta'){let el=state.items.get(p.itemId);if(!el){upsertItem({id:p.itemId,type:'agentMessage',text:''},p.turnId);el=state.items.get(p.itemId)}const body=el.querySelector('.message-text');body.dataset.raw=(body.dataset.raw||'')+p.delta;body.innerHTML=renderAssistantMarkdown(body.dataset.raw,{cwd:imageCwd()});scrollBottom()}
  else if(method==='item/reasoning/summaryPartAdded')upsertReasoningDelta(p,null);
  else if(method==='item/reasoning/summaryTextDelta')upsertReasoningDelta(p,'summary');
  else if(method==='item/reasoning/textDelta')upsertReasoningDelta(p,'content');
  else if(method==='item/commandExecution/outputDelta'){const turn=state.turns.get(p.turnId),row=turn?.querySelector(`[data-item-id="${CSS.escape(p.itemId)}"]`),item=state.activityItems.get(p.turnId)?.get(String(p.itemId));if(item)item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');if(row){const target=row.nextElementSibling.querySelector('.command-shell-output pre')||row.nextElementSibling;target.textContent=(target.classList.contains('empty')?'':target.textContent||'')+(p.delta||'');target.classList.remove('empty')}}
  else if(method==='item/commandExecution/terminalInteraction')applyTerminalInteraction(p)
  else if(method==='item/fileChange/outputDelta'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress'}:{id:itemId,type:'fileChange',status:'inProgress',changes:[]};item.aggregatedOutput=(item.aggregatedOutput||'')+(p.delta||'');upsertItem(item,p.turnId)}
  else if(method==='item/fileChange/patchUpdated'){const itemId=String(p.itemId),current=state.activityItems.get(p.turnId)?.get(itemId),item=current?.type==='fileChange'?{...current,status:'inProgress',changes:p.changes||[]}:{id:itemId,type:'fileChange',status:'inProgress',changes:p.changes||[]};upsertItem(item,p.turnId)}
  else if(method==='turn/diff/updated'){if(p.threadId&&state.active?.id&&p.threadId!==state.active.id)return;recordTurnReview(p.turnId,p.diff||'','native')}
  else if(method==='turn/completed'){if(p.threadId&&p.threadId!==state.active?.id)return;if(!p.turn?.id||activeTurnId()===p.turn.id)setActiveTurnId('');if(p.turn?.items)for(const i of p.turn.items)upsertItem(i,p.turn.id);if(p.turn?.id)syncTurnTiming({...p.turn,status:p.turn.status||'completed'});maybeNotifyTaskCompleted(p);scheduleActiveThreadSync(0);refreshThreadsSoon()}
  else if(method==='thread/tokenUsage/updated'){const threadId=p.threadId||state.active?.id;if(threadId&&p.tokenUsage)state.tokenUsage.set(threadId,p.tokenUsage);if(threadId===state.active?.id)renderContextUsage()}
  else if(method==='thread/status/changed'){syncThreadStatus(p.threadId,p.status);if(p.threadId===state.active?.id)scheduleActiveThreadSync(0);refreshThreadsSoon()}
  else if(method==='error')toast(p.error?.message||p.message||'Codex error');
}
function upsertReasoningDelta(p,field){const itemId=String(p.itemId),items=state.activityItems.get(p.turnId),current=items?.get(itemId),item=current?.type==='reasoning'?{...current,status:'inProgress'}:{id:itemId,type:'reasoning',status:'inProgress',summary:[],content:[]};if(field){const index=field==='summary'?(p.summaryIndex??0):(p.contentIndex??0),parts=Array.isArray(item[field])?[...item[field]]:[];while(parts.length<=index)parts.push('');parts[index]=(parts[index]||'')+(p.delta||'');item[field]=parts}upsertItem(item,p.turnId);scrollBottom()}
function setApprovalWaiting(group,itemId,waiting){if(!group)return;const row=itemId?group.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`):null,summary=group.querySelector('.activity-summary-copy');group.classList.toggle('waiting-approval',waiting);if(waiting){summary.textContent='Waiting for approval';summary.classList.remove('loading-shimmer');if(row){row.querySelector('.activity-name')?.classList.remove('loading-shimmer');state.motion.get(row)?.pause()}}else{if(row){row.querySelector('.activity-name')?.classList.add('loading-shimmer');state.motion.get(row)?.play()}updateActivitySummary(group)}}
function approvalIcon(kind){return kind==='network'?codexIcon('globe'):kind==='patch'?codexIcon('fileDiff'):kind==='permission'?codexIcon('shield'):codexIcon('terminal')}
function approvalBody(model,p){if(model.kind==='exec'||model.kind==='network')return `<div class="approval-command"><code>${escapeHtml(p.command||model.title)}</code></div>`;if(model.kind==='patch'){const review=diffForTurn(p.turnId);return review?.hasChanges?`<button type="button" class="approval-review-link">${codexIcon('fileDiff')}<span>Review ${review.fileCount} changed file${review.fileCount===1?'':'s'}</span><span class="plus">+${review.linesAdded}</span><span class="minus">−${review.linesDeleted}</span></button>`:''}return permissionRows(p.permissions).map(row=>`<div class="permission-row"><span>${escapeHtml(row.label)}</span><code>${escapeHtml(shortPath(row.value))}</code></div>`).join('')}
function onServerRequest(req){serverRequestRevision++;serverRequests.set(req.id,req);if(req.method==='item/tool/requestUserInput'){showUserInputDialog(req);return}if(req.params?.threadId!==state.active?.id)return;if(state.requestCards.has(req.id))return;if(req.method==='item/tool/requestUserInput'){showUserInputDialog(req);return}return onApprovalRequest(req)}
async function onApprovalRequest(req){const p=req.params||{};
if(req.requestStatus&&req.requestStatus!=='awaiting'){
  const card=document.createElement('section');card.className='approval-card approval-state-card';card.dataset.requestState=req.requestStatus;
  if(requestFinished(req.requestStatus)){
    const label=t(req.requestStatus==='accepted'?'Answer received':'Request ended');
    card.append(createRequestReceipt(document,`${label} · ${t('Approval')}`,p.command||p.reason||t('Approval')));
    mountRequestCard(document,card,req);state.requestCards.set(req.id,card);return;
  }
  const status=document.createElement('strong');status.textContent=t(({submitting:'Sending…',accepted:'Answer received',ended:'Request ended',recovering:'Waiting for the original request'})[req.requestStatus]||'Request ended');
  const detail=document.createElement('p');detail.textContent=p.command||p.reason||t('Approval');card.append(status,detail);$('#conversation').append(card);state.requestCards.set(req.id,card);return;
}
if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){void respondToCodex(req.id,null,{code:-32601,message:'Unsupported request'}).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});return}const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=buildApprovalModel(req),card=document.createElement('section');card.className='approval-card';card.dataset.codexApprovalSurface='';card.innerHTML=`<div class="approval-content"><div class="approval-identity">${approvalIcon(model.kind)}<span>${escapeHtml(model.identity)}</span></div><div class="approval-title">${escapeHtml(model.title)}</div>${model.subtitle?`<div class="approval-subtitle">${escapeHtml(shortPath(model.subtitle))}</div>`:''}${model.reason?`<div class="approval-reason"><span>Reason</span><p>${escapeHtml(model.reason)}</p></div>`:''}</div><div class="approval-body">${approvalBody(model,p)}</div><form class="approval-actions">${model.leading?`<button type="button" class="approval-leading">${escapeHtml(model.leading.label)}</button>`:''}<div class="approval-actions-main"><button type="button" class="approval-deny">${escapeHtml(model.deny.label)}</button>${model.scoped?`<div class="approval-split"><button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button><button type="button" class="approval-menu-toggle" aria-label="Approval options" aria-expanded="false">${codexIcon('chevronDown')}</button><div class="approval-menu" hidden><button type="button" class="approval-scoped">${escapeHtml(model.scoped.label)}</button></div></div>`:`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`}</div></form>`;group.after(card);state.requestCards.set(req.id,card);setApprovalWaiting(group,p.itemId,true);const answer=async(decision)=>{card.querySelectorAll('button').forEach(b=>b.disabled=true);try{const result=await respondToCodex(req.id,model.kind==='permission'?decision:{decision});setApprovalWaiting(group,p.itemId,false);if(req.requestKey){const current=serverRequests.get(req.id);if(current){if(current.requestStatus!=='ended')current.requestStatus=result.status;renderServerRequests()}}else resolveServerRequest(req.id)}catch(error){card.querySelectorAll('button').forEach(b=>b.disabled=false);if(!error?.silentTransportSwitch)toast(error.message)}};card.querySelector('form').onsubmit=e=>{e.preventDefault();answer(model.primary.decision)};card.querySelector('.approval-deny').onclick=()=>answer(model.deny.decision);card.querySelector('.approval-scoped')?.addEventListener('click',()=>answer(model.scoped.decision));card.querySelector('.approval-leading')?.addEventListener('click',()=>answer(model.leading.decision));card.querySelector('.approval-review-link')?.addEventListener('click',()=>openReviewPanel(diffForTurn(p.turnId)));const menuToggle=card.querySelector('.approval-menu-toggle'),menu=card.querySelector('.approval-menu');menuToggle?.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open))});scrollBottom()}
const slashCommandCatalog=[
  {id:'model',title:'Model',description:'Choose model and reasoning effort',icon:'wrench'},
  {id:'project',title:'Project',description:'Choose project for new tasks',icon:'folderOpen'},
  {id:'reasoning',title:'Reasoning',description:'Choose reasoning effort',icon:'wrench'},
  {id:'init',title:'Init',description:'Create an AGENTS.md file with instructions for Codex',icon:'file'},
  {id:'mcp',title:'MCP',description:'Show MCP server status',icon:'wrench'},
  {id:'status',title:'Status',description:'Show task id',icon:'info',requiresThread:true},
];
function closeComposerAutocomplete(){const menu=$('#composerAutocomplete');autocompleteState.requestId++;menu.hidden=true;menu.replaceChildren();delete menu.dataset.type;autocompleteState.match=null;autocompleteState.items=[];autocompleteState.selected=0;autocompleteState.message=''}
function renderComposerAutocomplete(){const menu=$('#composerAutocomplete'),items=autocompleteState.items;menu.innerHTML='';menu.dataset.type=autocompleteState.match?.type||'';menu.setAttribute('aria-label',autocompleteState.match?.type==='slash'?'Slash command menu':'Mention menu');if(!items.length){const empty=document.createElement('div');empty.className='autocomplete-empty';empty.textContent=autocompleteState.message||(autocompleteState.match?.type==='mention'?'Type to search for files':'No commands');menu.append(empty)}else for(const[index,item]of items.entries()){const button=document.createElement('button');button.type='button';button.className='autocomplete-item'+(index===autocompleteState.selected?' selected':'');button.dataset.autocompleteId=item.id;button.role='option';button.setAttribute('aria-selected',String(index===autocompleteState.selected));button.innerHTML=`${codexIcon(item.icon||'file')}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;button.onpointerdown=event=>event.preventDefault();button.onclick=()=>selectComposerAutocomplete(index);menu.append(button)}menu.hidden=false}
function currentComposerCwd(){if(state.projectless&&!state.active)return'';const path=state.active?.cwd||$('#projectPath').textContent||state.config.defaultCwd;return path.startsWith('~')?state.config.home+path.slice(1):path}
async function searchMentionSuggestions(match){const query=match.query.trim(),requestId=++autocompleteState.requestId;if(!query){autocompleteState.items=[];autocompleteState.message=state.projectless&&!state.active?'Choose a project to mention files':'Type to search for files';renderComposerAutocomplete();return}const tasks=state.threads.filter(thread=>titleOf(thread).toLowerCase().includes(query.toLowerCase())).slice(0,5).map(thread=>({id:`task:${thread.id}`,source:'task',threadId:thread.id,title:titleOf(thread),description:`Task · ${shortPath(thread.cwd)}`,icon:'messageSquare'})),cwd=currentComposerCwd();if(!cwd){autocompleteState.items=[{id:'choose-project',source:'action',title:'Choose project',description:'Select a project to mention files',icon:'folderOpen'},...tasks];autocompleteState.selected=0;autocompleteState.message='';renderComposerAutocomplete();return}autocompleteState.items=[];autocompleteState.message='Searching files…';renderComposerAutocomplete();try{const response=await fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'File search unavailable');if(requestId!==autocompleteState.requestId||autocompleteState.match?.type!=='mention'||autocompleteState.match.query!==match.query)return;const files=(data.items||[]).map(item=>{const parts=item.path.split('/');return{id:`${item.kind}:${item.path}`,source:item.kind,path:item.path,title:parts.at(-1),description:parts.length>1?parts.slice(0,-1).join('/'):(item.kind==='folder'?'Folder':'File'),icon:item.kind==='folder'?'folderOpen':'file'}});autocompleteState.items=[...files,...tasks];autocompleteState.selected=0;autocompleteState.message=autocompleteState.items.length?'':'No files or tasks found';renderComposerAutocomplete()}catch(error){if(requestId!==autocompleteState.requestId)return;autocompleteState.items=tasks;autocompleteState.message=tasks.length?'':error.message;renderComposerAutocomplete()}}
function updateComposerAutocomplete(){const input=$('#prompt'),match=getComposerAutocomplete(input.value,input.selectionStart??input.value.length);if(!match){closeComposerAutocomplete();return}autocompleteState.match=match;autocompleteState.selected=0;if(match.type==='slash'){autocompleteState.requestId++;const query=match.query.trim().toLowerCase();autocompleteState.items=slashCommandCatalog.filter(item=>(!item.requiresThread||state.active)&&(item.id.includes(query)||item.title.toLowerCase().includes(query)));autocompleteState.message='';renderComposerAutocomplete();return}searchMentionSuggestions(match)}
function moveComposerAutocomplete(delta){if(!autocompleteState.items.length)return;autocompleteState.selected=(autocompleteState.selected+delta+autocompleteState.items.length)%autocompleteState.items.length;renderComposerAutocomplete()}
function setPlanMode(active){state.planMode=Boolean(active);refreshComposerPlaceholder();syncPermissionControl()}
function applyAutocompleteToken(match,replacement){state.composerMessageId='';const input=$('#prompt'),result=applyComposerSuggestion(input.value,match,replacement);input.value=result.text;input.setSelectionRange(result.cursor,result.cursor);resizePrompt();saveComposerDraft()}
function renderContextTray(){const tray=$('#composerContextTray');tray.innerHTML='';for(const mention of state.composerMentions){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.contextId=mention.id;chip.innerHTML=`${codexIcon(mention.icon||'file')}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon('x')}</button>`;chip.querySelector('button').onclick=()=>{state.composerMentions=state.composerMentions.filter(item=>item.id!==mention.id);renderContextTray();saveComposerDraft()};tray.append(chip)}for(const image of state.composerImages){const chip=document.createElement('div');chip.className='composer-context-chip composer-image-chip';const previewButton=document.createElement('button');previewButton.type='button';previewButton.className='composer-image-preview';previewButton.dataset.imageSrc=image.url;previewButton.dataset.imageTitle=image.name;previewButton.setAttribute('aria-label',`${t('View image')}: ${image.name}`);const preview=document.createElement('img');preview.src=image.url;preview.alt=image.name;previewButton.append(preview);const name=document.createElement('span');name.textContent=image.name;const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label',t('Remove image'));remove.innerHTML=codexIcon('x');remove.onclick=()=>{state.composerMessageId='';state.composerImages=state.composerImages.filter(item=>item.id!==image.id);renderContextTray();saveComposerDraft();syncComposerSubmitState()};chip.append(previewButton,name,remove);tray.append(chip)}tray.hidden=!state.composerMentions.length&&!state.composerImages.length;syncComposerSubmitState()}
function selectComposerAutocomplete(index=autocompleteState.selected){const item=autocompleteState.items[index],match=autocompleteState.match;if(!item||!match)return;const id=item.id;if(item.source==='action'&&id==='choose-project'){closeComposerAutocomplete();openFolderPicker()}else if(item.source==='file'||item.source==='folder'){applyAutocompleteToken(match,`@${item.path}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();saveComposerDraft();closeComposerAutocomplete()}else if(item.source==='task'){applyAutocompleteToken(match,`@${item.title}`);if(!state.composerMentions.some(mention=>mention.id===item.id))state.composerMentions.push({...item});renderContextTray();saveComposerDraft();closeComposerAutocomplete()}else{if(id==='init')applyAutocompleteToken(match,'/init');closeComposerAutocomplete();if(id==='model'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='reasoning'){ $('#prompt').value='';resizePrompt();openModelMenu()}else if(id==='project'){ $('#prompt').value='';resizePrompt();openFolderPicker()}else if(id==='mcp'){ $('#prompt').value='';resizePrompt();openSettings('connections')}else if(id==='status'){ $('#prompt').value='';resizePrompt();toast(state.active?.id?`Task ${state.active.id}`:'No active task')}}requestAnimationFrame(()=>$('#prompt').focus())}
function handlePromptInput(){state.composerMessageId='';composerDraftReady=true;currentDraftOwner=composerDraftOwner();saveComposerDraft();resizePrompt();updateComposerAutocomplete()}
function handlePromptKeydown(event){if(event.isComposing||event.keyCode===229)return;const open=!$('#composerAutocomplete').hidden;if(open){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();moveComposerAutocomplete(event.key==='ArrowDown'?1:-1);return}if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();selectComposerAutocomplete();return}if(event.key==='Escape'){event.preventDefault();closeComposerAutocomplete();return}}if(event.key==='Enter'&&!event.shiftKey&&(!mobileSidebarEnabled()||event.ctrlKey||event.metaKey)){event.preventDefault();$('#composer').requestSubmit()}}
let composerSubmitting=false,imageReading=false,interruptPending=false;
async function attachComposerImages(files){
  if(imageReading||composerSubmitting)return;
  composerDraftReady=true;currentDraftOwner=composerDraftOwner();composerDirty=true;
  state.composerMessageId='';
  const targetImages=state.composerImages;imageReading=true;syncComposerSubmitState();
  try{const images=await readImageFiles(files,targetImages);if(targetImages===state.composerImages){state.composerMessageId='';state.composerImages.push(...images);renderContextTray();saveComposerDraft()}}
  catch(error){toast(t(error.message),5200)}
  finally{imageReading=false;syncComposerSubmitState()}
}
async function interruptActiveTurn(){
  if(interruptPending||!state.active||!activeTurnId())return;
  const threadId=state.active.id,turnId=activeTurnId();interruptPending=true;syncComposerSubmitState();
  try{await rpc('turn/interrupt',{threadId,turnId});if(threadId===state.active?.id)scheduleActiveThreadSync(0)}
  catch(error){if(!error?.silentTransportSwitch)toast(t(threadInputErrorMessage(error)),5200)}
  finally{interruptPending=false;syncComposerSubmitState()}
}

function showSubmittedMessage(submitted){
  if(!submitted||submitted.threadId!==state.active?.id)return;
  const existing=state.items.get(submitted.item.id);if(existing?.isConnected)return;
  const root=$('#conversation');root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());
  upsertItem(submitted.item,activeTurnId(),root);
  state.items.get(submitted.item.id).dataset.pendingMessageId=submitted.messageId;state.items.get(submitted.item.id)._submitted=submitted;
  scrollBottom();
}
function removeSubmittedMessage(messageId){const node=state.items.get(`host-sent-${messageId}`);if(node?.dataset.pendingMessageId!==messageId)return;node.remove();for(const[id,item]of state.items)if(item===node)state.items.delete(id)}
function renderQueuedMessages(){
  const container=$('#composerQueue');if(!container)return;
  const messages=state.queuedMessages.get(state.active?.id)||[];container.replaceChildren();container.hidden=!messages.length;
  for(const message of messages){
    const row=document.createElement('div');row.className='composer-queue-row';row.dataset.messageId=message.id;
    const copy=document.createElement('div'),status=document.createElement('span'),text=document.createElement('span');copy.className='composer-queue-copy';
    status.className='composer-queue-status';status.textContent=t(message.status==='failed'?'Send failed':message.status==='sending'?'Sending…':'Queued');
    text.className='composer-queue-text';text.setAttribute('data-i18n-ignore','');text.textContent=message.text||(message.imageCount?t('Image'):t('Message'));copy.append(status,text);
    if(message.imageCount&&message.text){const count=document.createElement('span');count.textContent=t('{count} images',{count:message.imageCount});copy.append(count)}
    if(message.error){const error=document.createElement('span');error.className='composer-queue-error';error.textContent=t(threadInputErrorMessage(message.error));copy.append(error)}
    row.append(copy);
    for(const action of message.status==='failed'?['retry','cancel']:['cancel']){
      const button=document.createElement('button');button.type='button';button.textContent=t(action==='retry'?'Retry':'Cancel');button.disabled=message.status==='sending';
      button.onclick=async()=>{button.disabled=true;const revision=queueRequestGate.next();try{const result=await rpc(`host/thread/queue/${action}`,{threadId:message.threadId,messageId:message.id});if(action==='cancel')removeSubmittedMessage(message.id);if(queueRequestGate.isCurrent(revision)){state.queuedMessages.set(message.threadId,result.messages||[]);renderQueuedMessages()}}catch(error){toast(t(error.message));button.disabled=false}};
      row.append(button);
    }
    container.append(row);
  }
}
async function submitPrompt(event){
  event.preventDefault();closeComposerAutocomplete();closePermissionMenu();
  const input=$('#prompt'),text=input.value.trim(),turnId=activeTurnId(),images=state.composerImages;
  if(turnId&&!text&&!images.length){await interruptActiveTurn();return}
  if(composerSubmitting||imageReading||(!text&&!images.length))return;
  let turnInput;
  try{turnInput=buildTurnInput(text,images)}catch(error){toast(t(error.message),5200);return}
  const messageId=state.composerMessageId||crypto.randomUUID();state.composerMessageId=messageId;
  const submittedDraft={text:input.value,mentions:structuredClone(state.composerMentions),images:structuredClone(images)},sourceDraftOwner=composerDraftOwner();
  const model=state.selectedModel,effort=$('#effortSelect').value;
  const threadPolicy=permissionThreadPolicy(),turnPolicy=permissionTurnPolicy(state.active?.cwd||currentComposerCwd());
  let thread=state.active;
  const submitRevision=openThreadGate.next();
  composerSubmitting=true;syncComposerSubmitState();
  try{
    if(!thread){
      const startingProjectless=state.projectless,cwd=$('#projectPath').textContent.replace(/^~/,state.config.home);
      const res=await rpc('thread/start',{cwd,model,...threadPolicy,sessionStartSource:'startup'});
      thread={...res.thread,projectless:startingProjectless};state.threads.unshift(thread);drafts.set(thread.id,'composer',submittedDraft);
      if(!state.active&&openThreadGate.isCurrent(submitRevision)){state.active=thread;rememberActiveThread(thread.id);renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML='';renderServerRequests();await sessionClient.activate(thread.id,true);if(state.active?.id===thread.id&&input.value.trim()===text&&JSON.stringify(state.composerImages.map(image=>image.url))===JSON.stringify(images.map(image=>image.url)))state.composerMessageId=messageId}
    }
    const queueRevision=queueRequestGate.next();
    showSubmittedMessage({messageId,threadId:thread.id,item:{id:`host-sent-${messageId}`,type:'userMessage',content:turnInput}});
    const result=await rpc('host/thread/send',{messageId,threadId:thread.id,input:turnInput,model,effort,cwd:thread.cwd,...turnPolicy,...(turnId?{expectedTurnId:turnId}:{})});
    if(result.accepted){if(sourceDraftOwner!==thread.id&&JSON.stringify(drafts.get(sourceDraftOwner,'composer'))===JSON.stringify(submittedDraft))drafts.set(sourceDraftOwner,'composer',null);if(JSON.stringify(drafts.get(thread.id,'composer'))===JSON.stringify(submittedDraft))drafts.set(thread.id,'composer',null)}
    if(result.delivered)handle(result.delivered);
    if(result.accepted)showSubmittedMessage(result.submitted||{messageId,threadId:thread.id,item:{id:`host-sent-${messageId}`,type:'userMessage',content:turnInput}});
    if(queueRequestGate.isCurrent(queueRevision)){state.queuedMessages.set(thread.id,result.messages||[]);renderQueuedMessages()}
    if(state.composerMessageId===messageId){input.value='';state.composerMentions=[];state.composerImages=[];state.composerMessageId='';renderContextTray();resizePrompt()}
  }catch(error){if(!error?.silentTransportSwitch){removeSubmittedMessage(messageId);toast(t(threadInputErrorMessage(error)),5200)}}
  finally{composerSubmitting=false;syncComposerSubmitState()}
}
function threadSummarySignature(threads){return JSON.stringify(threads.map(thread=>[thread.id,thread.updatedAt,thread.recencyAt,thread.status]))}
function applyThreadSummaries(threads){for(const thread of threads)observeThreadStatus(thread.id,thread.status);const nextSignature=threadSummarySignature(threads),changed=nextSignature!==threadListSignature;threadListSignature=nextSignature;state.threads=threads;if(changed)renderThreads()}
function scheduleThreadListRefresh(delay=THREAD_LIST_POLL_MS){clearTimeout(threadListTimer);threadListTimer=setTimeout(refreshThreadList,document.visibilityState==='hidden'?Math.max(delay,8000):delay)}
async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});applyThreadSummaries(result.data||[])}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}
function refreshThreadsSoon(){scheduleThreadListRefresh(600)}
function resetActiveThreadSync(){clearTimeout(activeThreadSyncTimer);activeThreadSyncTimer=null}
function scheduleActiveThreadSync(delay=0){resetActiveThreadSync();if(state.active)activeThreadSyncTimer=setTimeout(()=>sessionClient.reconnect(),delay)}

function activeTurnId(){return $('#sendButton')?.dataset.turnId||''}
function syncComposerSubmitState(){const button=$('#sendButton');if(!button)return;const mode=activeTurnId()?($('#prompt').value.trim()||state.composerImages.length?'steer':'stop'):'send',label=mode==='stop'?'Stop':mode==='steer'?'Steer':'Send message';button.disabled=interruptPending||(mode!=='stop'&&(imageReading||composerSubmitting));button.dataset.submitMode=mode;button.classList.toggle('stop',mode==='stop');button.classList.toggle('steer',mode==='steer');button.innerHTML=codexIcon(mode==='stop'?'square':'arrowUp');button.title=t(label);button.setAttribute('aria-label',t(label))}
function setActiveTurnId(turnId=''){const button=$('#sendButton');if(!button)return;button.dataset.turnId=turnId||'';syncComposerSubmitState()}
function syncTurnRuntime(turn){const active=turn?.status==='inProgress';if(active)setActiveTurnId(turn.id);else if(activeTurnId()===turn?.id)setActiveTurnId('')}
function syncTurnSnapshot(turn,threadId=state.active?.id){if(!turn||!threadId||threadId!==state.active?.id)return false;const root=$('#conversation'),nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<80,turns=state.active.turns||[],index=turns.findIndex(existing=>existing.id===turn.id);if(index<0)turns.push(turn);else turns[index]=turn;state.active.turns=turns;root.querySelectorAll('.conversation-loading').forEach(node=>node.remove());renderTurn(turn,root);syncTurnRuntime(turn);if(nearBottom)scrollBottom();return true}

function resizePrompt(){const e=$('#prompt');e.style.height='auto';e.style.height=Math.min(190,e.scrollHeight)+'px';syncComposerSubmitState()}
function scrollBottom(force=false){conversationScroll.bottom(force)}
function scrollOpenedThreadToBottom(){scrollBottom(true)}
function formatAge(ts){const s=Math.max(0,Date.now()/1000-ts);if(s<60)return'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return new Date(ts*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(text,duration=2200){const e=$('#toast');e.textContent=text;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),duration)}
function syncSummaryPanel(){const workspace=state.projectless?'No project':($('#projectName').textContent||'Local workspace');$('#summaryWorkspace').textContent=workspace;$('#summaryBranch').textContent=state.projectless?'':state.active?.source==='remote'?'Remote workspace':'Local workspace'}
function overlayPanelsEnabled(){return matchMedia('(max-width:1200px)').matches}
function setOverlayBackgroundInert(inert){for(const selector of ['.topbar','.sidebar','.conversation-shell','.bottom-panel']){const node=$(selector);if(node)node.inert=inert||(selector==='.conversation-shell'&&$('#sidebar').classList.contains('mobile-open'))}}
function focusPanel(panel,closeButton){if(!overlayPanelsEnabled())return;setOverlayBackgroundInert(true);panel.setAttribute('aria-modal','true');requestAnimationFrame(()=>closeButton.focus())}
function restorePanelFocus(panel,target){panel.setAttribute('aria-modal','false');if(!document.body.classList.contains('side-panel-open')&&!document.body.classList.contains('summary-panel-open'))setOverlayBackgroundInert(false);if(overlayPanelsEnabled()&&target?.isConnected){const focusTarget=mobileSidebarEnabled()&&$('#topActions').contains(target)?$('#mobileToolsButton'):target;requestAnimationFrame(()=>focusTarget.focus())}}
function syncOverlayPanelMode(){const overlay=overlayPanelsEnabled(),sideOpen=document.body.classList.contains('side-panel-open'),summaryOpen=document.body.classList.contains('summary-panel-open');setOverlayBackgroundInert(overlay&&(sideOpen||summaryOpen));$('#sidePanel').setAttribute('aria-modal',String(overlay&&sideOpen));$('#summaryPanel').setAttribute('aria-modal',String(overlay&&summaryOpen));if(overlay){const panel=summaryOpen?$('#summaryPanel'):sideOpen?$('#sidePanel'):null,close=summaryOpen?$('#closeSummaryPanel'):sideOpen?$('#closeSidePanel'):null;if(panel&&close&&!panel.contains(document.activeElement))requestAnimationFrame(()=>close.focus())}renderChanges()}
function setSidebarOpen(open){const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled();document.body.classList.toggle('sidebar-hidden',!mobile&&!open);sidebar.classList.toggle('mobile-open',mobile&&open);$('#sidebarBackdrop').hidden=!(mobile&&open);sidebar.inert=mobile&&!open;$('.conversation-shell').inert=mobile&&open||(overlayPanelsEnabled()&&(document.body.classList.contains('side-panel-open')||document.body.classList.contains('summary-panel-open')));const visible=mobile?sidebar.classList.contains('mobile-open'):!document.body.classList.contains('sidebar-hidden');$('#toggleSidebar').setAttribute('aria-expanded',String(visible));$('#toggleSidebar').setAttribute('aria-pressed',String(visible));if(mobile)$('#threadHeadingButton').setAttribute('aria-expanded',String(visible))}
function syncSidebarLayout(){const mobile=mobileSidebarEnabled();document.documentElement.classList.toggle('mobile-layout',mobile);document.documentElement.classList.toggle('mobile-device',mobile);if(mobile===sidebarLayoutMobile)return;sidebarLayoutMobile=mobile;setSidebarOpen(!mobile)}
function setBrowserStatus(text,tone='ready'){const status=$('#browserStatus');status.dataset.tone=tone;$('#browserStatusText').textContent=text}
function updateBrowserControls(){const current=browserState.history[browserState.index]||'';$('#browserBack').disabled=browserState.index<=0;$('#browserForward').disabled=browserState.index<0||browserState.index>=browserState.history.length-1;$('#browserRefresh').disabled=!current;for(const link of [$('#browserOpenExternal'),$('#browserNoticeExternal')]){link.hidden=!current;if(current)link.href=current}}
function showBrowserNotice(title,description,tone='error'){clearTimeout(browserState.loadTimer);const notice=$('#browserNotice');notice.dataset.tone=tone;notice.setAttribute('role',tone==='error'?'alert':'status');$('#browserNoticeTitle').textContent=t(title);$('#browserNoticeDescription').textContent=t(description);notice.hidden=false;$('#browserLoading').hidden=true;$('#browserFrameShell').setAttribute('aria-busy','false');setBrowserStatus(t(title),tone)}
function finishBrowserLoad(requestId){if(requestId!==browserState.loadRequest)return;showBrowserNotice('Page blank or refused?','Some sites block previews. Open in a new tab to browse normally.','ready');setBrowserStatus(t('Page preview'),'ready')}
function navigateBrowser(value,{push=true}={}){const result=normalizeBrowserUrl(value);if(result.error){showBrowserNotice('Invalid address',result.error);$('#browserUrl').setAttribute('aria-invalid','true');return false}const url=result.url;$('#browserUrl').removeAttribute('aria-invalid');$('#browserUrl').value=url;if(push&&browserState.history[browserState.index]!==url){browserState.history=browserState.history.slice(0,browserState.index+1);browserState.history.push(url);browserState.index=browserState.history.length-1}const requestId=++browserState.loadRequest,frame=$('#browserFrame');clearTimeout(browserState.loadTimer);$('#browserEmpty').hidden=true;$('#browserNotice').hidden=true;$('#browserLoading').hidden=false;frame.hidden=false;frame.setAttribute('sandbox',browserSandboxFor(url,location.href));$('#browserFrameShell').setAttribute('aria-busy','true');setBrowserStatus('Loading page...','loading');updateBrowserControls();frame.onload=()=>finishBrowserLoad(requestId);frame.onerror=()=>requestId===browserState.loadRequest&&showBrowserNotice('Page could not be loaded','The site did not complete the embedded request. Open it externally to continue.');frame.src=url;browserState.loadTimer=setTimeout(()=>{if(requestId===browserState.loadRequest)showBrowserNotice('Page may have blocked embedding','This site did not finish loading in the panel. It may block embedded browsers; you can open it externally instead.')},10000);return true}
function moveBrowserHistory(delta){const next=browserState.index+delta;if(next<0||next>=browserState.history.length)return;browserState.index=next;navigateBrowser(browserState.history[next],{push:false});updateBrowserControls()}
function openBrowserPanel(){if(mobileSidebarEnabled()){mobileNavigation.showPreview();updateBrowserControls();return}const tab=$('#utilityTab');tab.textContent='Browser';tab.dataset.sidePanelTab='browser';tab.hidden=false;setSidePanelOpen(true,false);setSidePanelView('browser','Browser');updateBrowserControls();if(browserState.index<0&&!overlayPanelsEnabled())requestAnimationFrame(()=>$('#browserUrl').focus())}
function setSidePanelView(view,title){const launcher=view==='launcher',review=view==='review',utility=view==='utility',browser=view==='browser',terminal=view==='terminal',sideTask=view==='side-task';$('#sidePanelLauncher').hidden=!launcher;$('#reviewPanelContent').hidden=!review;$('#browserPanel').hidden=!browser;$('#sideTerminalPanel').hidden=!terminal;$('#sideTaskPanel').hidden=!sideTask;$('#utilityPanelContent').hidden=!utility;for(const tab of document.querySelectorAll('.side-panel-tab')){const selected=tab.dataset.sidePanelTab===view;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected))}$('#newTab').hidden=false;if(review)$('#reviewTab').hidden=false;if(utility||browser||terminal||sideTask)$('#utilityTab').hidden=false;$('#sidePanelTitle').textContent=title||(launcher?'New tab':review?'Review':$('#utilityTab').textContent);renderChanges();if(terminal)requestAnimationFrame(()=>{initializeTerminal(terminalStates.side);fitTerminal(terminalStates.side);terminalStates.side.term?.focus()});if(sideTask)renderSideTasks();if(overlayPanelsEnabled()&&document.body.classList.contains('side-panel-open'))requestAnimationFrame(()=>$('#closeSidePanel').focus())}
function openReviewPanel(review=null){state.activeReview=review||[...state.turnDiffs.values()].at(-1)||state.activeReview;setSidePanelOpen(true,false);setSidePanelView('review','Review')}
function openUtilityPanel(kind){if(kind==='browser'){openBrowserPanel();return}const tab=$('#utilityTab');if(kind==='terminal'){tab.textContent='Terminal';tab.dataset.sidePanelTab='terminal';setSidePanelOpen(true,false);setSidePanelView('terminal','Terminal');return}if(kind==='side-task'){tab.textContent='Side tasks';tab.dataset.sidePanelTab='side-task';setSidePanelOpen(true,false);setSidePanelView('side-task','Side tasks');return}const labels={files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']},entry=labels[kind];if(!entry)return;const[title,icon,description]=entry;tab.textContent=title;tab.dataset.sidePanelTab='utility';$('#utilityPanelTitle').textContent=title;$('#utilityPanelDescription').textContent=description;$('#utilityPanelIcon').innerHTML=codexIcon(icon);const action=$('#utilityPanelAction');action.hidden=false;action.textContent='Choose project folder';action.onclick=openFolderPicker;setSidePanelOpen(true,false);setSidePanelView('utility',title)}
function setSidePanelOpen(open,reset=true){if(open)mobileNavigation?.showChat();const panel=$('#sidePanel'),trigger=$('#toggleSidePanel'),wasOpen=!panel.hidden;if(open){setSummaryPanelOpen(false);if(!wasOpen){sidePanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('side-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true')}if(reset)setSidePanelView('launcher','New tab');if(!wasOpen)focusPanel(panel,$('#closeSidePanel'))}else{panel.hidden=true;document.body.classList.remove('side-panel-open','review-split-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,sidePanelReturnFocus);sidePanelReturnFocus=null}}
function setSummaryPanelOpen(open){const panel=$('#summaryPanel'),trigger=$('#toggleSummaryPanel');if(open){setSidePanelOpen(false,false);summaryPanelReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:trigger;panel.hidden=false;document.body.classList.add('summary-panel-open');trigger.setAttribute('aria-pressed','true');trigger.setAttribute('aria-expanded','true');syncSummaryPanel();focusPanel(panel,$('#closeSummaryPanel'))}else{panel.hidden=true;document.body.classList.remove('summary-panel-open');trigger.setAttribute('aria-pressed','false');trigger.setAttribute('aria-expanded','false');restorePanelFocus(panel,summaryPanelReturnFocus);summaryPanelReturnFocus=null}}
function closeImageViewer(){const dialog=$('#imageViewer');if(dialog.open)dialog.close()}
function openImageViewer(source,title='Image',path=''){const dialog=$('#imageViewer'),image=$('#imageViewerImage');imageViewerReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;$('#imageViewerTitle').textContent=title||'Image';$('#imageViewerPath').textContent=path||title||'';$('#imageViewerError').hidden=true;image.hidden=false;image.alt=title||'';image.src=source;$('#imageViewerOriginal').href=source;if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>$('#closeImageViewer').focus())}
function currentTerminalCwd(){const path=state.active?.cwd||localStorage.getItem('codex-webui-project')||state.config.defaultCwd||$('#projectPath').textContent||'.';return path.startsWith('~')?state.config.home+path.slice(1):path}
function terminalIsVisible(terminalState){const host=$(`#${terminalState.hostId}`),panel=$(`#${terminalState.panelId}`);return host&&!host.hidden&&panel&&!panel.hidden}
function fitTerminal(terminalState){const host=$(`#${terminalState.hostId}`);if(!terminalState.fit||!terminalIsVisible(terminalState)||host.clientWidth<1||host.clientHeight<1)return;try{terminalState.fit.fit()}catch{}}
function sendTerminalResize(terminalState){const ws=terminalState.ws,term=terminalState.term;if(ws?.readyState===WebSocket.OPEN&&term)ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}
function connectTerminal(terminalState){if(terminalState.ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(terminalState.ws.readyState))return;clearTimeout(terminalState.reconnectTimer);const proto=location.protocol==='https:'?'wss:':'ws:',host=$(`#${terminalState.hostId}`),ws=new WebSocket(`${proto}//${location.host}/terminal?cwd=${encodeURIComponent(currentTerminalCwd())}`);terminalState.ws=ws;ws.binaryType='arraybuffer';host.dataset.connected='false';ws.onopen=()=>{host.dataset.connected='true';requestAnimationFrame(()=>{fitTerminal(terminalState);sendTerminalResize(terminalState);terminalState.term?.focus()})};ws.onmessage=async event=>{const data=event.data instanceof Blob?new Uint8Array(await event.data.arrayBuffer()):event.data instanceof ArrayBuffer?new Uint8Array(event.data):String(event.data);terminalState.term?.write(data)};ws.onerror=()=>ws.close();ws.onclose=()=>{host.dataset.connected='false';if(terminalState.ws===ws)terminalState.ws=null;if(terminalIsVisible(terminalState))terminalState.reconnectTimer=setTimeout(()=>connectTerminal(terminalState),1000)}}
function initializeTerminal(terminalState){if(terminalState.term){connectTerminal(terminalState);requestAnimationFrame(()=>fitTerminal(terminalState));return}const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme:dark)').matches),host=$(`#${terminalState.hostId}`),term=new Terminal({cursorBlink:true,cursorStyle:'block',fontFamily:'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',fontSize:12,lineHeight:1.2,scrollback:5000,theme:dark?{background:'#181818',foreground:'#f2f2f2',cursor:'#f2f2f2',selectionBackground:'#3b4a5a'}:{background:'#ffffff',foreground:'#0d0d0d',cursor:'#0d0d0d',selectionBackground:'#c8dcf4'}}),fit=new FitAddon;term.loadAddon(fit);term.open(host);terminalState.term=term;terminalState.fit=fit;term.onData(data=>{const ws=terminalState.ws;if(ws?.readyState===WebSocket.OPEN)ws.send(new TextEncoder().encode(data))});term.onResize(()=>sendTerminalResize(terminalState));terminalState.resizeObserver=new ResizeObserver(()=>requestAnimationFrame(()=>fitTerminal(terminalState)));terminalState.resizeObserver.observe(host);connectTerminal(terminalState);globalThis.__codexTerminals=terminalStates;if(terminalState===terminalStates.bottom)globalThis.__codexTerminal={term,fit,state:terminalState}}
function setBottomPanelView(kind='launcher'){const launcher=kind==='launcher',terminal=kind==='terminal',labels={browser:['Browser','globe','Open Browser from the right panel to keep it beside the chat.'],files:['Files','folderOpen','Choose or switch the local project folder available to this WebUI.']};$('#bottomPanelLauncher').hidden=!launcher;$('#terminalHost').hidden=!terminal;$('#bottomPanelUtility').hidden=launcher||terminal;$('#bottomPanelTab').textContent=launcher?'New tab':terminal?'Terminal':labels[kind]?.[0]||'New tab';if(launcher)return;bottomPanelLastView=kind;if(terminal){initializeTerminal(terminalStates.bottom);requestAnimationFrame(()=>{fitTerminal(terminalStates.bottom);terminalStates.bottom.term?.focus()});return}const[title,icon,description]=labels[kind];$('#bottomPanelIcon').innerHTML=codexIcon(icon);$('#bottomPanelUtilityTitle').textContent=title;$('#bottomPanelDescription').textContent=description;const action=$('#bottomPanelAction');action.hidden=kind!=='files';action.textContent='Choose project folder';action.onclick=kind==='files'?openFolderPicker:null}
function setBottomPanelOpen(open){const panel=$('#bottomPanel');panel.hidden=!open;document.body.classList.toggle('bottom-panel-open',open);$('#toggleBottomPanel').setAttribute('aria-pressed',String(open));$('#toggleBottomPanel').setAttribute('aria-expanded',String(open));if(open)setBottomPanelView(bottomPanelLastView||'launcher')}
function setSidebarSearchOpen(open){const panel=$('#sidebarSearchPanel'),input=$('#threadSearch');panel.hidden=!open;$('#sidebarSearchButton').setAttribute('aria-expanded',String(open));if(open){requestAnimationFrame(()=>input.focus());return}if(input.value){input.value='';renderThreads()}}

$('#newTab').onclick=()=>setSidePanelView('launcher','New tab');$('#reviewTab').onclick=()=>openReviewPanel(state.activeReview);$('#utilityTab').onclick=()=>setSidePanelView($('#utilityTab').dataset.sidePanelTab,$('#utilityTab').textContent);$('#openSidePanelTab').onclick=()=>setSidePanelView('launcher','New tab');for(const action of document.querySelectorAll('[data-side-panel-action]'))action.onclick=()=>action.dataset.sidePanelAction==='review'?openReviewPanel():openUtilityPanel(action.dataset.sidePanelAction);$('#browserAddressForm').onsubmit=event=>{event.preventDefault();navigateBrowser($('#browserUrl').value)};$('#browserBack').onclick=()=>moveBrowserHistory(-1);$('#browserForward').onclick=()=>moveBrowserHistory(1);$('#browserRefresh').onclick=()=>browserState.index>=0&&navigateBrowser(browserState.history[browserState.index],{push:false});$('#bottomPanelTab').onclick=()=>setBottomPanelView();for(const action of document.querySelectorAll('[data-bottom-panel-action]'))action.onclick=()=>setBottomPanelView(action.dataset.bottomPanelAction);$('#reviewMode').onclick=()=>{reviewPreferences.mode=reviewPreferences.mode==='unified'?'split':'unified';saveReviewPreferences();renderChanges()};$('#reviewWrap').onclick=()=>{reviewPreferences.wrap=!reviewPreferences.wrap;saveReviewPreferences();renderChanges()};$('#reviewExpand').onclick=()=>{reviewPreferences.expanded=!reviewPreferences.expanded;saveReviewPreferences();renderChanges()};$('#reviewPatch').onclick=applyActiveReviewPatch;$('#composer').addEventListener('submit',submitPrompt);$('#prompt').addEventListener('input',handlePromptInput);$('#prompt').addEventListener('keydown',handlePromptKeydown);$('#threadSearch').addEventListener('input',renderThreads);$('#modelButton').addEventListener('click',toggleModelMenu);$('#modeButton').onclick=togglePermissionMenu;$('#confirmFullAccess').onclick=()=>{const action=pendingFullAccessAction;$('#fullAccessDialog').close();if(action==='enable')setPermissionVisibility('fullAccess',true);else setPermissionMode('full-access');pendingFullAccessAction='select'};$('#fullAccessDialog').addEventListener('close',()=>{pendingFullAccessAction='select';syncPermissionSettings();if($('#settingsDialog').open&&document.querySelector('[data-settings-page="agent"].active'))setSettingsPage('agent',{updateRoute:false})});document.querySelector('[data-composer-control="add"]').onclick=()=>$('#composerImageInput').click();$('#composerImageInput').onchange=event=>{void attachComposerImages(event.target.files);event.target.value=''};$('#prompt').addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])].filter(file=>file.type.startsWith('image/'));if(!files.length)return;event.preventDefault();const text=event.clipboardData.getData('text/plain');if(text){const input=$('#prompt');input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');resizePrompt()}void attachComposerImages(files)});$('#newTask').onclick=()=>{if(mobileSidebarEnabled())setSidebarOpen(false);startNewTask()};$('#sidebarBackdrop').onclick=()=>{setSidebarOpen(false);$('#threadHeadingButton').focus()};$('#projectButton').onclick=openFolderPicker;$('#composerProjectButton').onclick=openFolderPicker;$('#projectlessOption').onclick=useProjectless;$('#accountButton').onclick=e=>{e.stopPropagation();if(state.account?.type==='chatgpt')toggleAccountMenu();else openSettings('general')};$('#folderGo').onclick=()=>loadFolders($('#folderPathInput').value);$('#folderPathInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();loadFolders(e.currentTarget.value)}};$('#folderUp').onclick=()=>folderBrowse.parent&&loadFolders(folderBrowse.parent);$('#folderConfirm').onclick=useSelectedFolder;$('#toggleSummaryPanel').onclick=()=>setSummaryPanelOpen($('#summaryPanel').hidden);$('#closeImageViewer').onclick=closeImageViewer;$('#imageViewerImage').onload=()=>{$('#imageViewerImage').hidden=false;$('#imageViewerError').hidden=true};$('#imageViewerImage').onerror=()=>{$('#imageViewerImage').hidden=true;$('#imageViewerError').hidden=false};$('#imageViewer').addEventListener('click',event=>{if(event.target===event.currentTarget)closeImageViewer()});$('#imageViewer').addEventListener('close',()=>{const image=$('#imageViewerImage');image.removeAttribute('src');if(imageViewerReturnFocus?.isConnected)imageViewerReturnFocus.focus();imageViewerReturnFocus=null});function mobileSidebarEnabled(){return matchMedia('(max-width:720px)').matches}
$('#sidebarSearchButton').onclick=event=>{event.stopPropagation();setSidebarSearchOpen($('#sidebarSearchPanel').hidden)};$('#sidebarSearchClose').onclick=()=>setSidebarSearchOpen(false);$('#accountSettings').onclick=()=>openSettings('general-settings');$('#accountProfile').onclick=()=>openSettings('profile');$('#accountShortcuts').onclick=()=>openSettings('keyboard-shortcuts');for(const button of document.querySelectorAll('[data-settings-page]'))button.onclick=()=>openSettings(button.dataset.settingsPage);$('#settingsAutoReviewToggle').onchange=event=>setPermissionVisibility('autoReview',event.currentTarget.checked);$('#settingsTaskNotifyToggle').onchange=event=>setTaskNotifyEnabled(event.currentTarget.checked);$('#settingsFullAccessToggle').onchange=event=>{if(!event.currentTarget.checked){setPermissionVisibility('fullAccess',false);return}event.currentTarget.checked=false;pendingFullAccessAction='enable';const dialog=$('#fullAccessDialog');if(!dialog.open)dialog.showModal()};$('#accountLogout').onclick=async()=>{if(!confirm('Log out?'))return;try{await rpc('account/logout');toggleAccountMenu(false);await loadAccount(true)}catch(error){toast(error.message)}};$('#settingsDialog').addEventListener('cancel',event=>{event.preventDefault();closeSettings()});
$('#settingsPermissionValue').onclick=()=>setSettingsPage('agent');
$('#settingsProjectValue').onclick=()=>{closeSettings();openFolderPicker()};
const THEME_STORAGE_KEY='codex-webui-theme';
function applyTheme(value){
  const theme=['light','dark'].includes(value)?value:'system';
  $('#themeSelect').value=theme;
  if(theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=theme;
  const dark=theme==='dark'||(theme==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);
  for(const terminal of Object.values(terminalStates))if(terminal.term)terminal.term.options.theme=dark?{background:'#181818',foreground:'#f2f2f2',cursor:'#f2f2f2',selectionBackground:'#3b4a5a'}:{background:'#ffffff',foreground:'#0d0d0d',cursor:'#0d0d0d',selectionBackground:'#c8dcf4'};
}
applyTheme(localStorage.getItem(THEME_STORAGE_KEY));
$('#themeSelect').onchange=event=>{applyTheme(event.currentTarget.value);localStorage.setItem(THEME_STORAGE_KEY,$('#themeSelect').value)};
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>applyTheme(localStorage.getItem(THEME_STORAGE_KEY)));
const INTERFACE_SCALE_STORAGE_KEY='codex-webui-interface-scale';
function applyInterfaceScale(value){
  const select=$('#interfaceScaleSelect'),scale=[...select.options].some(option=>option.value===String(value))?String(value):'100';
  select.value=scale;document.documentElement.style.setProperty('--interface-scale',String(Number(scale)/100));
  return scale;
}
applyInterfaceScale(localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY));
$('#interfaceScaleSelect').onchange=event=>{
  const scale=applyInterfaceScale(event.currentTarget.value);localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY,scale);
  requestAnimationFrame(()=>{resizePrompt();dispatchEvent(new Event('resize'))});
};
$('#languageSelect').value=i18n.preference;
$('#languageSelect').onchange=event=>i18n.setPreference(event.currentTarget.value);
function refreshLocalizedRuntime(){
  $('#languageSelect').value=i18n.preference;
  if(!state.active)$('#threadTitle').textContent=t('New task');
  if(!folderBrowse.selected)$('#folderSelection').textContent=t('No folder selected');
  if(state.account)renderAccount(state.account);else for(const id of ['accountName','accountMenuName','settingsAccountName'])$(`#${id}`).textContent=t('Settings');
  syncPermissionControl();syncModelLabel();refreshComposerPlaceholder();renderContextUsage();renderChanges();
  syncComposerSubmitState();
  if(!$('#modelMenu').hidden)renderModelMenuMain();
  if($('#settingsDialog').open){const current=document.querySelector('[data-settings-page].active')?.dataset.settingsPage||settingsRoutePage()||'general-settings';setSettingsPage(current,{updateRoute:false});filterSettingsNavigation($('#settingsSearch').value)}
}
i18n.subscribe(refreshLocalizedRuntime);
refreshLocalizedRuntime();
$('#toggleSidePanel').onclick=()=>setSidePanelOpen($('#sidePanel').hidden);$('#toggleBottomPanel').onclick=()=>setBottomPanelOpen($('#bottomPanel').hidden);$('#closeBottomPanel').onclick=()=>setBottomPanelOpen(false);$('#toggleSidebar').onclick=()=>setSidebarOpen(mobileSidebarEnabled()?!$('#sidebar').classList.contains('mobile-open'):document.body.classList.contains('sidebar-hidden'));$('#closeSidePanel').onclick=()=>setSidePanelOpen(false);$('#closeSummaryPanel').onclick=()=>setSummaryPanelOpen(false);document.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null,image=target?.closest('[data-image-src]');if(image){e.preventDefault();openImageViewer(image.dataset.imageSrc,image.dataset.imageTitle||image.querySelector('img')?.alt||'Image',image.dataset.imagePath||'');return}if(target?.closest('a[data-file-download]'))return;const citation=target?.closest('a[data-file-reference]');if(!citation)return;e.preventDefault();dispatchEvent(new CustomEvent('codex-webui:file-reference',{detail:{path:citation.dataset.fileReference,lineStart:Number(citation.dataset.fileLineStart)||null,lineEnd:Number(citation.dataset.fileLineEnd)||null}}))});document.addEventListener('click',e=>{const path=e.composedPath();if(!path.includes($('#modelPicker')))closeModelMenu();if(!path.includes($('#permissionPicker')))closePermissionMenu();if(!path.includes($('#accountMenu'))&&!path.includes($('#accountButton')))toggleAccountMenu(false);if(!path.includes($('#sidebarSearchPanel'))&&!path.includes($('#sidebarSearchButton')))setSidebarSearchOpen(false)});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;scheduleThreadListRefresh(0);scheduleActiveThreadSync(0)});addEventListener('keydown',e=>{if(e.target instanceof Element&&e.target.closest('.terminal-host'))return;if(e.key==='Escape'){if($('#imageViewer').open){e.preventDefault();closeImageViewer();return}if($('#folderDialog').open||$('#fullAccessDialog').open)return;if(e.defaultPrevented)return;if(!$('#sidebarSearchPanel').hidden){e.preventDefault();setSidebarSearchOpen(false);return}if($('#settingsDialog').open){e.preventDefault();closeSettings();return}closeModelMenu();closePermissionMenu();toggleAccountMenu(false);if(document.body.classList.contains('side-panel-open'))setSidePanelOpen(false);else if(document.body.classList.contains('summary-panel-open'))setSummaryPanelOpen(false);else if($('#sidebar').classList.contains('mobile-open')){setSidebarOpen(false);$('#threadHeadingButton').focus()}}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();startNewTask()}if((e.metaKey||e.ctrlKey)&&e.key==='b'){e.preventDefault();$('#toggleSidebar').click()}if((e.metaKey||e.ctrlKey)&&e.key==='j'){e.preventDefault();$('#toggleBottomPanel').click()}});addEventListener('resize',()=>{syncOverlayPanelMode();syncSidebarLayout();for(const terminalState of Object.values(terminalStates))requestAnimationFrame(()=>fitTerminal(terminalState))});
mobileNavigation=initializeMobileNavigation({
  isMobile:mobileSidebarEnabled,
  toggleSidebar:()=>setSidebarOpen(!$('#sidebar').classList.contains('mobile-open')),
  newChat:startNewTask,
  closePanels:()=>{setSidebarOpen(false);if(!$('#sidePanel').hidden)setSidePanelOpen(false,false);if(!$('#summaryPanel').hidden)setSummaryPanelOpen(false)},
  refreshUsage:refreshMobileUsage,
});
globalThis.__codexWebuiDebug={notify:onNotification,request:onServerRequest,state,browserState,navigateBrowser,renderChanges,renderAccount,renderHeader,refreshComposerPlaceholder,setProjectless,openImageViewer,openThread,loadInitial,startNewTask,setSidebarOpen,openSettings,closeSettings,settingsRoutePage,selectedPermission,permissionThreadPolicy,permissionTurnPolicy,setPermissionMode,setPermissionProfiles,setPermissionVisibility,renderPermissionMenu,filterAppModels,renderModels,syncTurnSnapshot,recordTurnReview,scrollOpenedThreadToBottom};
async function loadAccessSettingsAvailability(){
  const button=$('[data-settings-page="access-settings"]');
  try{const response=await fetch('/api/auth/status',{cache:'no-store'}),status=await response.json();button.dataset.settingsAvailable=String(response.ok&&status.canManageCredentials===true)}catch{button.dataset.settingsAvailable='false'}
  filterSettingsNavigation($('#settingsSearch').value);
}
async function boot(){loadAccessSettingsAvailability();const savedProject=localStorage.getItem('codex-webui-project');syncSidebarLayout();syncPermissionControl();try{state.config=await fetch('/api/config').then(r=>r.json())}catch{}if(state.config.projectless||savedProject==='~')setProjectless();else setWorkspace(savedProject||state.config.defaultCwd||'.');refreshComposerPlaceholder();const initialSettingsPage=settingsRoutePage();if(initialSettingsPage)showSettings(initialSettingsPage,{updateRoute:false});connect()}
boot();
