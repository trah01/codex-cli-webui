import { codexInterfaceMark } from './codex-brand.js';
import { createDomI18n, createI18n } from './i18n.js';

const $=selector=>document.querySelector(selector);
const i18n=globalThis.__codexWebuiI18n||createI18n();
globalThis.__codexWebuiI18n=i18n;
globalThis.__codexWebuiDomI18n=globalThis.__codexWebuiDomI18n||createDomI18n(i18n);
const t=message=>i18n.t(message);

async function loadApp(){
  for(const href of ['/vendor/katex/katex.min.css','/vendor/xterm/xterm.css']){
    if(document.querySelector(`link[href="${href}"]`))continue;
    const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);
  }
  await import('/app.bundle.js');
}

async function start(){
  let status;
  try{
    const response=await fetch('/api/auth/status',{cache:'no-store'});
    if(!response.ok)throw new Error(`Authentication status failed (${response.status})`);
    status=await response.json();
  }catch(reason){console.error('[codex-cli-webui] authentication status failed',reason);return}
  const logout=$('#webuiLogoutButton');
  const enableLogout=()=>{
    logout.hidden=false;logout.textContent=t('Sign out');
    logout.onclick=async()=>{
      logout.disabled=true;
      try{const response=await fetch('/api/auth/logout',{method:'POST'});if(!response.ok)throw new Error('Sign out failed');location.reload()}
      catch{logout.disabled=false;logout.textContent=t('Try again')}
    };
  };
  if(status.authenticated){enableLogout();await loadApp();return}
  const gate=$('#passwordGate'),app=$('#app'),input=$('#passwordInput'),confirmInput=$('#passwordConfirmInput'),form=$('#passwordLoginForm'),button=$('#passwordLoginButton'),error=$('#passwordError'),title=$('#passwordTitle');
  let mode=status.setupRequired?'setup':'login';
  const username=$('#loginUsername');username.hidden=!(status.usernameRequired||status.setupRequired);username.required=!username.hidden;
  const otp=$('#otpInput');otp.hidden=!status.otpRequired;otp.required=Boolean(status.otpRequired);otp.placeholder=t('Verification code');
  const oidc=$('#oidcLoginButton');oidc.hidden=!status.oidcEnabled;oidc.textContent=t('Single sign-on');oidc.onclick=()=>{location.href='/api/auth/oidc/start'};
  if(status.passwordEnabled===false){input.hidden=true;input.required=false;username.hidden=true;username.required=false;button.hidden=true;}

  $('#passwordCodexMark').innerHTML=codexInterfaceMark('password-codex-mark');
  const configure=()=>{
    const setup=mode==='setup';
    title.textContent=t(setup?'Set a LAN password':'Log in');
    gate.setAttribute('aria-label',t(setup?'codex-cli-webui password setup':'codex-cli-webui login'));
    input.placeholder=t(setup?'New password':'Password');
    input.autocomplete=setup?'new-password':'current-password';
    input.minLength=setup?12:0;
    input.maxLength=256;
    confirmInput.hidden=!setup;confirmInput.required=setup;confirmInput.value='';
    button.textContent=t(setup?'Set password':'Log in');
  };
  configure();gate.hidden=false;app.setAttribute('aria-hidden','true');app.inert=true;requestAnimationFrame(()=>status.passwordEnabled===false?oidc.focus():input.focus());
  if(status.setupRequired&&!status.canManageCredentials){
    title.textContent=t('Public access is not configured');
    input.hidden=true;confirmInput.hidden=true;username.hidden=true;button.hidden=true;
    error.textContent=t('Open http://127.0.0.1 on the server to set the access username and password.');error.hidden=false;
    return;
  }
  form.onsubmit=async event=>{
    event.preventDefault();error.hidden=true;
    if(mode==='setup'&&input.value.length<12){error.textContent=t('Password must be at least 12 characters');error.hidden=false;input.focus();return}
    if(mode==='setup'&&input.value!==confirmInput.value){error.textContent=t('Passwords do not match');error.hidden=false;confirmInput.select();return}
    const endpoint=mode==='setup'?'/api/auth/setup':'/api/auth/login';
    button.disabled=true;button.textContent=t(mode==='setup'?'Setting password…':'Logging in…');
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:username.value,password:input.value,otp:otp.value})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok){
        if(mode==='setup'&&response.status===409){mode='login';input.value='';configure();throw new Error(t('A password was already set. Log in to continue.'));}
        throw new Error(t(data.error||(mode==='setup'?'Unable to set the password':'Unable to log in')));
      }
      gate.hidden=true;app.removeAttribute('aria-hidden');app.inert=false;input.value='';confirmInput.value='';username.value='';otp.value='';enableLogout();
      await loadApp();
    }catch(reason){error.textContent=reason instanceof Error?reason.message:String(reason);error.hidden=false;input.select()}
    finally{button.disabled=false;button.textContent=t(mode==='setup'?'Set password':'Log in')}
  };
}

start().catch(error=>console.error('[codex-cli-webui] authentication bootstrap failed',error));
