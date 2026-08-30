import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build, buildSync, type Plugin } from "esbuild";
import { runEmailSignInThrottleCarrier } from "../src/server/services/sign-in-email-throttle";

const root = resolve(import.meta.dirname, "..");
const workerRuntime = resolve(root, "..", "..", "..", "worker-runtime");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const operationStorageKey = "cubby:global-session-revoke-operation";

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: { message?: string } };
type SyntheticMode = "pending-retry" | "terminal-reconciliation" | "current-redirect" | "all-redirect" | "layout";
type SyntheticSession = {
  handle: string;
  isCurrent: boolean;
  deviceLabel: string;
  createdAt: string;
  lastQualifyingAt: string;
  idleWarningAt: string | null;
  expiresAt: string;
  ipAddress: string;
  userAgent: string;
  rawToken: string;
  internalId: string;
  householdId: string;
  babyId: string;
};

const syntheticSessionInternals = {
  ipAddress: "198.51.100.77",
  userAgent: "ForbiddenFullUserAgent/7.0 acceptance-secret",
  rawToken: "raw-session-token-must-never-render",
  internalId: "internal-session-id-must-never-render",
  householdId: "household-id-must-never-render",
  babyId: "baby-id-must-never-render"
} as const;

const syntheticSecrets = {
  ...syntheticSessionInternals,
  firstPassword: "phase7-first-password-must-not-persist",
  secondPassword: "phase7-second-password-must-not-persist",
  cancelPassword: "phase7-cancel-password-must-clear"
} as const;

const initialSessions: SyntheticSession[] = [
  {
    handle: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    isCurrent: true,
    deviceLabel: "Chrome on Windows",
    createdAt: "2026-08-01T12:00:00.000Z",
    lastQualifyingAt: "2026-08-29T12:00:00.000Z",
    idleWarningAt: null,
    expiresAt: "2026-09-01T12:00:00.000Z",
    ...syntheticSessionInternals
  },
  {
    handle: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    isCurrent: false,
    deviceLabel: "Safari on iPhone",
    createdAt: "2026-08-20T12:00:00.000Z",
    lastQualifyingAt: "2026-08-28T12:00:00.000Z",
    idleWarningAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z",
    ...syntheticSessionInternals
  }
];

async function cdpConnect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, rejectOpen) => { socket.onopen = () => resolveOpen(); socket.onerror = () => rejectOpen(new Error("phase7_browser_cdp_connect_failed")); });
  let nextId = 1;
  const pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }>();
  const diagnostics: Array<{ method: string; params: unknown }> = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded") diagnostics.push({ method: message.method, params: message.params });
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("phase7_browser_cdp_failed")); else request.resolve(message);
  };
  return {
    call(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      return new Promise<CdpMessage>((resolveCall, rejectCall) => { pending.set(id, { resolve: resolveCall, reject: rejectCall }); socket.send(JSON.stringify({ id, method, params })); });
    },
    diagnostics() { return diagnostics.slice(-5); },
    close() { socket.close(); }
  };
}

async function terminateChrome(process: ChildProcess) {
  if (!process.pid || process.exitCode !== null) return;
  const result = spawnSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { stdio: "ignore" });
  if (result.error || result.status !== 0) process.kill();
  for (let attempt = 0; attempt < 60 && process.exitCode === null && process.signalCode === null; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (process.exitCode === null && process.signalCode === null) throw new Error("phase7_browser_chrome_cleanup_incomplete");
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function sessionManagerBundlePlugin(): Plugin {
  return {
    name: "phase7-session-manager-navigation-shim",
    setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "phase7-shim" }));
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next/link", namespace: "phase7-link-shim" }));
      build.onLoad({ filter: /.*/, namespace: "phase7-shim" }, () => ({
        loader: "js",
        contents: "export const useRouter=()=>({push:(url)=>globalThis.__phase7Router.pushes.push(url),refresh:()=>{globalThis.__phase7Router.refreshes+=1}});"
      }));
      build.onLoad({ filter: /.*/, namespace: "phase7-link-shim" }, () => ({
        loader: "js",
        contents: "export default function Link({href,children,...props}){return globalThis.React.createElement('a',{...props,href},children)}"
      }));
    }
  };
}

const sessionManagerCss = `
*{box-sizing:border-box}html,body{margin:0;max-width:100%;overflow-x:hidden}body{padding:16px;font-family:Arial,sans-serif;color:#292524;background:#fffaf5}button,input{font:inherit;min-height:44px}button{min-width:44px;border:1px solid #a8a29e;border-radius:8px;padding:8px 16px;background:white;color:#292524}input{border:1px solid #a8a29e;border-radius:8px;padding:8px 12px}.space-y-4>*+*{margin-top:16px}.space-y-3>*+*{margin-top:12px}.space-y-1>*+*{margin-top:4px}.grid{display:grid}.gap-3{gap:12px}.gap-2{gap:8px}.flex{display:flex}.flex-col{flex-direction:column}.flex-col-reverse{flex-direction:column-reverse}.items-start{align-items:flex-start}.items-center{align-items:center}.justify-center{justify-content:center}.w-full{width:100%}.min-w-0{min-width:0}.flex-1{flex:1}.flex-wrap{flex-wrap:wrap}.break-words{overflow-wrap:anywhere}ul{list-style:none;padding:0;margin:0}li{min-width:0}dl{margin:8px 0 0}h2,h3,p{overflow-wrap:anywhere}section{width:100%;min-width:0}@media(min-width:768px){ul{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const securityHistoryCss = `${sessionManagerCss}
ol{list-style:none;padding:0;margin:0}.sm\\:flex-row{flex-direction:column}.sm\\:justify-between{justify-content:flex-start}.sm\\:w-auto{width:100%}.rounded-lg{border-radius:8px}.border{border:1px solid #a8a29e}.p-4{padding:16px}.text-sm{font-size:14px}.text-xs{font-size:12px}@media(min-width:640px){.sm\\:flex-row{flex-direction:row}.sm\\:justify-between{justify-content:space-between}.sm\\:w-auto{width:auto}}`;

async function runSecurityHistoryAcceptance(client: Awaited<ReturnType<typeof cdpConnect>>, origin: string) {
  const forbidden = [
    "security-history-internal-id", "security-history-raw-key", "security-history-password",
    "198.51.100.71", "ForbiddenHistoryUserAgent/1.0", "security-history-household", "security-history-baby"
  ];
  const inspect = async (width: number, height: number, desktop: boolean) => {
    await client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: !desktop });
    await client.call("Page.navigate", { url: `${origin}/security-history` });
    let loaded = false;
    for (let attempt = 0; attempt < 240 && !loaded; attempt += 1) {
      try {
        const state = await client.call("Runtime.evaluate", { expression: `document.readyState==='complete'&&typeof globalThis.__phase8HistoryRemount==='function'`, returnByValue: true });
        loaded = state.result?.result?.value === true;
      } catch {
        // Navigation can replace the execution context between CDP calls.
      }
      if (!loaded) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!loaded) throw new Error(`phase8_security_history_document_not_loaded:${JSON.stringify(client.diagnostics()).slice(-1000)}`);
    const result = await client.call("Runtime.evaluate", {
      expression: `(async()=>{
        const forbidden=${JSON.stringify(forbidden)};
        const waitFor=async(predicate,code)=>{for(let attempt=0;attempt<240;attempt+=1){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error(code)};
        await waitFor(()=>document.body.textContent.includes('Sign In'),'history_not_loaded');
        const surfaces=()=>[document.documentElement.outerHTML,location.href,JSON.stringify({...localStorage}),JSON.stringify({...sessionStorage}),JSON.stringify(globalThis.__phase8HistoryRequests||[])];
        const assertSafe=()=>{if(forbidden.some(value=>surfaces().some(surface=>surface.includes(value))))throw new Error('history_forbidden_browser_surface');};
        assertSafe();
        const exportButton=[...document.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Export history');if(!exportButton)throw new Error('history_export_button_missing');
        exportButton.click();await waitFor(()=>document.querySelector('[aria-label="Confirm security history export"]'),'history_confirmation_missing');
        const region=document.querySelector('[aria-label="Confirm security history export"]');const cancel=[...region.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Cancel');if(document.activeElement!==cancel)throw new Error('history_confirmation_focus_missing');
        cancel.click();await waitFor(()=>!document.querySelector('[aria-label="Confirm security history export"]'),'history_cancel_missing');
        if(document.activeElement!==exportButton)throw new Error('history_cancel_focus_restore_missing');
        const loadMore=[...document.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Load more');if(!loadMore)throw new Error('history_pagination_missing');loadMore.click();await waitFor(()=>document.querySelectorAll('[aria-label="Security history events"] li').length===2,'history_second_page_missing');
        await waitFor(()=>document.body.textContent.includes('More security history loaded.'),'history_load_more_live_announcement_missing');
        exportButton.click();await waitFor(()=>document.querySelector('[aria-label="Confirm security history export"]'),'history_second_confirmation_missing');
        const download=[...document.querySelectorAll('[aria-label="Confirm security history export"] button')].find(node=>node.textContent?.trim()==='Download export');download.click();await waitFor(()=>globalThis.__phase8Download==='cubby-global-security-history-v1-UTC.json','history_download_missing');
        await waitFor(()=>document.activeElement===exportButton,'history_completion_focus_restore_missing');

        const controls=[...document.querySelectorAll('button')];if(controls.some(control=>{const rect=control.getBoundingClientRect();return rect.width<44||rect.height<44}))throw new Error('history_touch_target_invalid');
        assertSafe();return{overflow:document.documentElement.scrollWidth-innerWidth,flex:getComputedStyle(document.querySelector('section>div')).flexDirection,requests:globalThis.__phase8HistoryRequests};
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.result?.exceptionDetails) throw new Error(`phase8_security_history_browser_interaction_failed:${JSON.stringify(result.result.exceptionDetails).slice(-1000)}`);
    const value = result.result?.result?.value as { overflow?: number; flex?: string; requests?: string[] } | undefined;
    if (!value || value.overflow !== 0 || (desktop ? value.flex !== "row" : value.flex !== "column") || value.requests?.join("|") !== "GET /api/account/security-history|GET /api/account/security-history?cursor=opaque-page-cursor|POST /api/account/security-history/export") throw new Error("phase8_security_history_browser_projection_invalid");
  };
  await inspect(375, 812, false);
  await inspect(1280, 900, true);
  console.log("P1_3_SECURITY_HISTORY_BROWSER_ACCEPTANCE_PASS");
}

async function runSignInAcceptance(client: Awaited<ReturnType<typeof cdpConnect>>, origin: string) {
  await client.call("Page.navigate", { url: origin });
  const passwords = ["existing-browser-proof", "absent-browser-proof", "quiet-existing-proof", "quiet-absent-proof", "evidence-existing-proof", "evidence-absent-proof", "success-browser-proof", "success-unavailable-proof", "quiet-handler-proof", "lookup-handler-proof"];
  const result = await client.call("Runtime.evaluate", {
    expression: `(async()=>{
      const call=async(email,password)=>{const response=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});return{status:response.status,text:await response.text(),headers:[...response.headers].sort()}};
      const existing=await call('existing@acceptance.invalid',${JSON.stringify(passwords[0])});
      const absent=await call('absent@acceptance.invalid',${JSON.stringify(passwords[1])});
      const quietExisting=await call('quiet-existing@acceptance.invalid',${JSON.stringify(passwords[2])});
      const quietAbsent=await call('quiet-absent@acceptance.invalid',${JSON.stringify(passwords[3])});
      const unavailableExisting=await call('evidence-existing@acceptance.invalid',${JSON.stringify(passwords[4])});
      const unavailableAbsent=await call('evidence-absent@acceptance.invalid',${JSON.stringify(passwords[5])});
      const success=await call('success@acceptance.invalid',${JSON.stringify(passwords[6])});
      const successUnavailable=await call('success-unavailable@acceptance.invalid',${JSON.stringify(passwords[7])});
      const quietHandlerUnavailable=await call('quiet-handler-unavailable@acceptance.invalid',${JSON.stringify(passwords[8])});
      const lookupHandlerUnavailable=await call('lookup-handler-unavailable@acceptance.invalid',${JSON.stringify(passwords[9])});
      return{existing,absent,quietExisting,quietAbsent,unavailableExisting,unavailableAbsent,success,successUnavailable,quietHandlerUnavailable,lookupHandlerUnavailable,url:location.href,html:document.documentElement.outerHTML,local:{...localStorage},session:{...sessionStorage}};
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.result?.exceptionDetails) throw new Error("phase8_sign_in_browser_interaction_failed");
  const value = result.result?.result?.value as Record<string, { status?: number; text?: string; headers?: string[][] }> & { url?: string; html?: string; local?: unknown; session?: unknown };
  const same = (left: { status?: number; text?: string; headers?: string[][] }, right: { status?: number; text?: string; headers?: string[][] }) => left.status === right.status && left.text === right.text && JSON.stringify(left.headers) === JSON.stringify(right.headers);
  const invalid = !same(value.existing, value.absent) || !same(value.quietExisting, value.quietAbsent) || !same(value.unavailableExisting, value.unavailableAbsent) || !same(value.unavailableExisting, value.successUnavailable) || !same(value.unavailableExisting,value.quietHandlerUnavailable) || !same(value.unavailableExisting,value.lookupHandlerUnavailable)
    || value.existing.status !== 401 || value.quietExisting.status !== 401 || value.unavailableExisting.status !== 503 || value.success.status !== 200
    || [value.existing,value.absent,value.quietExisting,value.quietAbsent,value.unavailableExisting,value.unavailableAbsent].some((entry) => entry.headers?.some(([name]) => name.toLowerCase() === "retry-after"));
  const surfaces = JSON.stringify({ url: value.url, html: value.html, local: value.local, session: value.session });
  if (invalid || passwords.some((password) => surfaces.includes(password))) throw new Error("phase8_sign_in_browser_neutrality_or_retention_invalid");
  console.log("P1_3_SIGN_IN_BROWSER_ACCEPTANCE_PASS");
}

async function runSessionManagerAcceptance(client: Awaited<ReturnType<typeof cdpConnect>>, origin: string) {
  await client.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await client.call("Page.navigate", { url: `${origin}/session-manager` });
  let loaded = false;
  for (let attempt = 0; attempt < 240 && !loaded; attempt += 1) {
    try {
      const state = await client.call("Runtime.evaluate", { expression: `document.readyState==='complete'&&typeof globalThis.__phase7Remount==='function'`, returnByValue: true });
      loaded = state.result?.result?.value === true;
    } catch {
      // Navigation can replace the execution context between CDP calls.
    }
    if (!loaded) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (!loaded) throw new Error(`phase7_session_manager_document_not_loaded:${JSON.stringify(client.diagnostics()).slice(-1000)}`);
  const expression = `(async () => {
    const waitFor = async (predicate, code) => {
      for (let attempt=0;attempt<240;attempt+=1) { const value=predicate(); if(value)return value; await new Promise(resolve=>setTimeout(resolve,25)); }
      throw new Error(code);
    };
    const button = (name) => [...document.querySelectorAll('button')].find(node=>node.textContent?.trim()===name);
    const click = async (name) => { const node=await waitFor(()=>button(name),'button_missing:'+name); node.click(); await new Promise(resolve=>setTimeout(resolve,0)); };
    const typePassword = (value) => { const input=document.querySelector('#session-current-password'); if(!input)throw new Error('password_missing'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); };
    const reset = async (mode) => { sessionStorage.clear(); localStorage.clear(); await fetch('/__acceptance/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})}); globalThis.__phase7Remount(); await waitFor(()=>document.body.textContent.includes('Safari on iPhone'),'sessions_not_loaded'); };
    const storage = () => ({local:{...localStorage},session:{...sessionStorage}});
    const forbidden = ${JSON.stringify([...Object.values(syntheticSecrets), ...initialSessions.map((session) => session.handle)])};
    const assertNoForbiddenRetention = (allowMetadata=false) => {
      const surfaces=[location.href,document.documentElement.outerHTML,JSON.stringify({...localStorage})];
      if(!allowMetadata)surfaces.push(JSON.stringify({...sessionStorage}));
      for(const value of forbidden)if(surfaces.some(surface=>surface.includes(value)))throw new Error('forbidden_browser_surface');
    };
    await waitFor(()=>document.body.textContent.includes('Safari on iPhone'),'mobile_sessions_not_loaded');
    const safeText=document.body.textContent;
    for(const expected of ['Chrome on Windows','Safari on iPhone','Signed in:','Last active:','Expires:','Idle warning:'])if(!safeText.includes(expected))throw new Error('safe_projection_missing');
    assertNoForbiddenRetention();
    const controls=[...document.querySelectorAll('button,input')];
    if(!controls.length||controls.some(control=>!(control.getAttribute('aria-label')||control.labels?.[0]?.textContent||control.textContent)?.trim()))throw new Error('accessible_name_missing');
    if(controls.some(control=>{const rect=control.getBoundingClientRect();return rect.width<44||rect.height<44}))throw new Error('mobile_touch_target_invalid');
    if(document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth)throw new Error('mobile_horizontal_overflow');

    await click('Sign out this session');
    const focused=document.querySelector('#session-current-password');
    await waitFor(()=>document.activeElement===focused,'password_focus_invalid');
    typePassword(${JSON.stringify(syntheticSecrets.cancelPassword)});
    await click('Cancel');
    await click('Sign out this session');
    if(document.querySelector('#session-current-password')?.value!=='')throw new Error('cancel_secret_not_cleared');
    await click('Cancel');
    assertNoForbiddenRetention();

    await reset('pending-retry');
    await click('Sign out this session');
    typePassword(${JSON.stringify(syntheticSecrets.firstPassword)});
    await click('Confirm sign out');
    await waitFor(()=>document.querySelector('[role=alert]'),'unknown_alert_missing');
    const retained=storage();
    const retainedKeys=Object.keys(retained.session);
    if(retainedKeys.length!==1||retainedKeys[0]!==${JSON.stringify(operationStorageKey)})throw new Error('metadata_storage_key_invalid');
    const metadata=JSON.parse(retained.session[retainedKeys[0]]);
    if(Object.keys(metadata).sort().join('|')!=='intentFingerprint|openingFingerprint|operationId'||!/^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(metadata.operationId)||!/^[0-9a-f]{64}$/.test(metadata.openingFingerprint)||!/^[0-9a-f]{64}$/.test(metadata.intentFingerprint))throw new Error('metadata_projection_invalid');
    assertNoForbiddenRetention(true);
    const retainedSerialized=JSON.stringify(retained);
    for(const value of forbidden)if(retainedSerialized.includes(value))throw new Error('secret_or_handle_persisted');
    typePassword(${JSON.stringify(syntheticSecrets.secondPassword)});
    await click('Confirm sign out');
    await waitFor(()=>!document.body.textContent.includes('Safari on iPhone'),'terminal_refresh_missing');
    const pendingState=await fetch('/__acceptance/state').then(response=>response.json());
    if(pendingState.requests.join('|')!=='GET sessions|POST revoke|POST status|POST status|POST revoke|GET sessions')throw new Error('status_before_reexecution_invalid');
    if(sessionStorage.length!==0)throw new Error('terminal_metadata_not_cleared');
    assertNoForbiddenRetention();

    await reset('terminal-reconciliation');
    await click('Sign out this session');
    typePassword(${JSON.stringify(syntheticSecrets.firstPassword)});
    await click('Confirm sign out');
    await waitFor(()=>document.querySelector('[role=alert]'),'terminal_setup_unknown_missing');
    typePassword(${JSON.stringify(syntheticSecrets.secondPassword)});
    await click('Confirm sign out');
    await waitFor(()=>!document.body.textContent.includes('Safari on iPhone'),'terminal_status_refresh_missing');
    const terminalState=await fetch('/__acceptance/state').then(response=>response.json());
    if(terminalState.requests.join('|')!=='GET sessions|POST revoke|POST status|POST status|GET sessions')throw new Error('terminal_status_reexecution_invalid');
    if(sessionStorage.length!==0)throw new Error('terminal_status_metadata_not_cleared');

    for(const mode of ['current-redirect','all-redirect']) {
      await reset(mode);
      await click(mode==='current-redirect'?'Sign out this device':'Sign out all devices');
      typePassword(${JSON.stringify(syntheticSecrets.secondPassword)});
      await click('Confirm sign out');
      await waitFor(()=>globalThis.__phase7Router.pushes.includes('/login'),'login_redirect_missing');
      if(globalThis.__phase7Router.refreshes<1)throw new Error('login_refresh_missing');
      const redirectState=await fetch('/__acceptance/state').then(response=>response.json());
      const expectedScope=mode==='current-redirect'?'current':'all';
      if(redirectState.lastScope!==expectedScope)throw new Error('redirect_scope_invalid');
      assertNoForbiddenRetention();
    }
    return {width:innerWidth,height:innerHeight,mobileOverflow:document.documentElement.scrollWidth-innerWidth};
  })()`;
  const mobile = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (mobile.result?.exceptionDetails) {
    let detail = JSON.stringify(mobile.result.exceptionDetails);
    for (const value of [...Object.values(syntheticSecrets), ...initialSessions.map((session) => session.handle)]) detail = detail.replaceAll(value, "[REDACTED]");
    throw new Error(`phase7_session_manager_mobile_acceptance_failed:${detail.slice(-1000)}`);
  }
  const mobileResult = mobile.result?.result?.value as { width?: number; height?: number; mobileOverflow?: number } | undefined;
  if (mobileResult?.width !== 375 || mobileResult.height !== 812 || mobileResult.mobileOverflow !== 0) throw new Error("phase7_session_manager_mobile_viewport_invalid");

  await client.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const desktop = await client.call("Runtime.evaluate", {
    expression: `(async()=>{sessionStorage.clear();localStorage.clear();await fetch('/__acceptance/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'layout'})});globalThis.__phase7Remount();for(let i=0;i<240&&!document.body.textContent.includes('Safari on iPhone');i+=1)await new Promise(r=>setTimeout(r,25));const cards=[...document.querySelectorAll('li')];const columns=getComputedStyle(document.querySelector('ul')).gridTemplateColumns.split(' ').filter(Boolean);const forbidden=${JSON.stringify([...Object.values(syntheticSecrets), ...initialSessions.map((session) => session.handle)])};const surfaces=[location.href,document.documentElement.outerHTML,JSON.stringify({...localStorage}),JSON.stringify({...sessionStorage})];return{width:innerWidth,height:innerHeight,cardCount:cards.length,columns:columns.length,sameRow:cards.length===2&&Math.abs(cards[0].getBoundingClientRect().top-cards[1].getBoundingClientRect().top)<1,separateColumns:cards.length===2&&cards[0].getBoundingClientRect().left!==cards[1].getBoundingClientRect().left,overflow:document.documentElement.scrollWidth-innerWidth,forbidden:forbidden.some(value=>surfaces.some(surface=>surface.includes(value))),unnamed:[...document.querySelectorAll('button,input')].some(control=>!(control.getAttribute('aria-label')||control.labels?.[0]?.textContent||control.textContent)?.trim())}})()`,
    awaitPromise: true,
    returnByValue: true
  });
  if (desktop.result?.exceptionDetails) throw new Error("phase7_session_manager_desktop_acceptance_failed");
  const desktopResult = desktop.result?.result?.value as { width?: number; height?: number; cardCount?: number; columns?: number; sameRow?: boolean; separateColumns?: boolean; overflow?: number; forbidden?: boolean; unnamed?: boolean } | undefined;
  if (!desktopResult || desktopResult.width !== 1280 || desktopResult.height !== 900 || desktopResult.cardCount !== 2 || desktopResult.columns !== 2 || !desktopResult.sameRow || !desktopResult.separateColumns || desktopResult.overflow !== 0 || desktopResult.forbidden || desktopResult.unnamed) throw new Error("phase7_session_manager_desktop_layout_invalid");
  console.log("P1_3_SESSION_MANAGER_BROWSER_ACCEPTANCE_PASS");
}

export async function runP13EmailChangeBrowserAcceptance(applicationOrigin?: string) {
  if (!existsSync(chromePath)) throw new Error("phase6_browser_chrome_missing");
  const suffix = randomBytes(8).toString("hex");
  mkdirSync(workerRuntime, { recursive: true });
  const runRoot = resolve(workerRuntime, `cubby-p1-3-email-browser-${suffix}`);
  const profile = resolve(runRoot, "profile");
  const carrierBundle = resolve(runRoot, "carrier.js");
  const sessionManagerBundle = resolve(runRoot, "session-manager.js");
  const securityHistoryBundle = resolve(runRoot, "security-history.js");
  mkdirSync(profile, { recursive: true });
  buildSync({ entryPoints: [resolve(root, "src/lib/auth/email-change-verification-carrier.ts")], bundle: true, platform: "browser", format: "iife", globalName: "EmailChangeCarrierModule", outfile: carrierBundle, logLevel: "silent" });
  await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{SessionManager}from'./src/components/settings/session-manager.tsx';globalThis.React=React;let root;globalThis.__phase7Remount=()=>{root?.unmount();globalThis.__phase7Router={pushes:[],refreshes:0};const container=document.getElementById('root');container.replaceChildren();root=createRoot(container);root.render(React.createElement(SessionManager));};globalThis.__phase7Remount();`,
      resolveDir: root,
      sourcefile: "phase7-session-manager-entry.ts"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: sessionManagerBundle,
    plugins: [sessionManagerBundlePlugin()],
    logLevel: "silent"
  });
  await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{SecurityHistory}from'./src/components/settings/security-history.tsx';globalThis.React=React;globalThis.__phase8HistoryRemount=()=>{const container=document.getElementById('root');container.replaceChildren();createRoot(container).render(React.createElement(SecurityHistory));};globalThis.__phase8HistoryRemount();`,
      resolveDir: root,
      sourcefile: "phase8-security-history-entry.ts"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: securityHistoryBundle,
    logLevel: "silent"
  });
  const carrierHtml = `<!doctype html><meta charset="utf-8"><title>Phase 6 carrier</title><script src="/carrier.js"></script><main id="result">ready</main>`;
  const sessionManagerHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 7 SessionManager</title><style>${sessionManagerCss}</style></head><body><main id="root"></main><script src="/session-manager.js"></script></body></html>`;
  const securityHistoryHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 8 Security history</title><style>${securityHistoryCss}</style></head><body><main id="root"></main><script>globalThis.__phase8Download='';HTMLAnchorElement.prototype.click=function(){globalThis.__phase8Download=this.download||''};globalThis.__phase8HistoryRequests=[];const phase8Fetch=globalThis.fetch;globalThis.fetch=(input,init={})=>{const value=typeof input==='string'?input:input.url;if(value.startsWith('/api/account/security-history'))globalThis.__phase8HistoryRequests.push((init.method||'GET')+' '+value);return phase8Fetch(input,init)};</script><script src="/security-history.js"></script></body></html>`;
  let mode: SyntheticMode = "layout";
  let activeSessions = initialSessions.slice();
  let requests: string[] = [];
  let statusCalls = 0;
  let revokeCalls = 0;
  let lastScope: string | null = null;
  const safeSessions = () => activeSessions.map(({ handle, isCurrent, deviceLabel, createdAt, lastQualifyingAt, idleWarningAt, expiresAt }) => ({ handle, isCurrent, deviceLabel, createdAt, lastQualifyingAt, idleWarningAt, expiresAt }));
  const validMetadata = (value: Record<string, unknown>) => /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(String(value.operationId ?? "")) && /^[0-9a-f]{64}$/.test(String(value.openingFingerprint ?? "")) && /^[0-9a-f]{64}$/.test(String(value.intentFingerprint ?? ""));
  const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/carrier.js") { response.setHeader("content-type", "text/javascript"); response.end(readFileSync(carrierBundle)); return; }
    if (url.pathname === "/session-manager.js") { response.setHeader("content-type", "text/javascript"); response.end(readFileSync(sessionManagerBundle)); return; }
    if (url.pathname === "/security-history.js") { response.setHeader("content-type", "text/javascript"); response.end(readFileSync(securityHistoryBundle)); return; }
    if (url.pathname === "/session-manager") { response.setHeader("content-type", "text/html"); response.end(sessionManagerHtml); return; }
    if (url.pathname === "/security-history") { response.setHeader("content-type", "text/html"); response.end(securityHistoryHtml); return; }
    if (url.pathname === "/__acceptance/reset" && request.method === "POST") {
      const parsed = JSON.parse(await requestBody(request)) as { mode?: SyntheticMode };
      if (!parsed.mode || !["pending-retry", "terminal-reconciliation", "current-redirect", "all-redirect", "layout"].includes(parsed.mode)) return json(response, 400, { ok: false });
      mode = parsed.mode;
      activeSessions = initialSessions.slice();
      requests = [];
      statusCalls = 0;
      revokeCalls = 0;
      lastScope = null;
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/__acceptance/state") return json(response, 200, { requests, lastScope });
    if (url.pathname === "/api/account/security-history" && request.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      return json(response, 200, { ok: true, data: { events: cursor ? [{ handle: "opaque-history-handle-two", eventClass: "grant", action: "current_password", outcome: "current_password_verified", occurredAt: "2026-08-29T12:01:00.000Z" }] : [{ handle: "opaque-history-handle-one", eventClass: "credential", action: "sign_in", outcome: "sign_in_succeeded", occurredAt: "2026-08-29T12:00:00.000Z" }], nextCursor: cursor ? null : "opaque-page-cursor" } });
    }
    if (url.pathname === "/api/account/security-history/export" && request.method === "POST") {
      const body = JSON.parse(await requestBody(request)) as { confirmed?: boolean };
      if (body.confirmed !== true) return json(response, 422, { ok: false });
      return json(response, 200, { schemaVersion: 1, exportType: "cubby_global_security_history", exportedAt: "2026-08-29T12:00:00.000Z", events: [] });
    }
    if (url.pathname === "/api/auth/sign-in/email" && request.method === "POST") {
      const rawBody = await requestBody(request);
      const submitted = JSON.parse(rawBody) as { email?: string };
      const scenario = String(submitted.email ?? "").split("@", 1)[0] ?? "";
      const headers = new Headers();
      for (const [name, headerValue] of Object.entries(request.headers)) {
        if (Array.isArray(headerValue)) for (const item of headerValue) headers.append(name, item);
        else if (headerValue !== undefined) headers.set(name, headerValue);
      }
      const carrierResponse = await runEmailSignInThrottleCarrier(new Request(`http://127.0.0.1/api/auth/sign-in/email`, { method: "POST", headers, body: rawBody }), {
        throttleKey: Buffer.alloc(32, 8).toString("base64url"),
        trustedProxyHops: 0,
        findUserIdByNormalizedEmail: async () => {
          if (scenario === "lookup-handler-unavailable") throw new Error("synthetic_lookup_failure");
          return scenario.includes("existing") || scenario.startsWith("success") ? "synthetic-existing-user" : undefined;
        },
        precheck: async () => ({ quiet: scenario.startsWith("quiet-"), deadline: null }),
        recordFailure: async () => {
          if (scenario.startsWith("evidence-")) throw new Error("synthetic_evidence_failure");
          return { quiet: scenario.startsWith("quiet-"), deadline: null };
        },
        invoke: async (forwarded) => {
          const forwardedBody = await forwarded.clone().json() as { email?: string };
          if (["success-unavailable","quiet-handler-unavailable","lookup-handler-unavailable"].includes(scenario)) throw new Error("synthetic_atomic_session_event_failure");
          if (scenario.startsWith("quiet-") && !String(forwardedBody.email).startsWith("cubby-throttle-")) return new Response("synthetic_quiet_secret_verification_attempted", { status: 500 });
          if (scenario === "success") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }), { status: 401, headers: { "content-type": "application/json" } });
        }
      });
      response.statusCode = carrierResponse.status;
      carrierResponse.headers.forEach((headerValue, name) => response.setHeader(name, headerValue));
      response.end(await carrierResponse.text());
      return;
    }
    if (url.pathname === "/api/account/sessions" && request.method === "GET") {
      requests.push("GET sessions");
      return json(response, 200, { ok: true, data: { sessions: safeSessions() } });
    }
    if (url.pathname === "/api/account/sessions/status" && request.method === "POST") {
      requests.push("POST status");
      const parsed = JSON.parse(await requestBody(request)) as Record<string, unknown>;
      if (Object.keys(parsed).sort().join("|") !== "intentFingerprint|openingFingerprint|operationId" || !validMetadata(parsed)) return json(response, 400, { ok: false });
      statusCalls += 1;
      if (statusCalls <= 1) return json(response, 503, { ok: false, error: { message: "Synthetic unknown status" } });
      if (mode === "terminal-reconciliation") {
        activeSessions = activeSessions.filter((session) => session.isCurrent);
        return json(response, 200, { ok: true, data: { status: "revoked" } });
      }
      return json(response, 200, { ok: true, data: { status: "pending" } });
    }
    if (url.pathname === "/api/account/sessions/revoke" && request.method === "POST") {
      requests.push("POST revoke");
      revokeCalls += 1;
      const parsed = JSON.parse(await requestBody(request)) as Record<string, unknown>;
      lastScope = typeof parsed.scope === "string" ? parsed.scope : null;
      const expectedKeys = parsed.scope === "one" || parsed.scope === "current" ? "confirmed|currentPassword|intentFingerprint|openingFingerprint|operationId|scope|targetHandle" : "confirmed|currentPassword|intentFingerprint|openingFingerprint|operationId|scope";
      if (Object.keys(parsed).sort().join("|") !== expectedKeys || !validMetadata(parsed) || parsed.confirmed !== true || !["current", "one", "others", "all"].includes(String(parsed.scope)) || typeof parsed.currentPassword !== "string" || parsed.currentPassword.length === 0 || parsed.currentPassword === syntheticSecrets.cancelPassword || (parsed.scope === "one" && !activeSessions.some((session) => session.handle === parsed.targetHandle))) return json(response, 400, { ok: false });
      if ((mode === "pending-retry" || mode === "terminal-reconciliation") && revokeCalls === 1) return json(response, 503, { ok: false, error: { message: "Synthetic lost response" } });
      if (parsed.scope === "one") activeSessions = activeSessions.filter((session) => session.handle !== parsed.targetHandle);
      const signedOut = parsed.scope === "current" || parsed.scope === "all";
      return json(response, 200, { ok: true, data: { status: "revoked", signedOut } });
    }
    response.setHeader("content-type", "text/html");
    response.end(carrierHtml);
  });
  let chrome: ChildProcess | undefined;
  let client: Awaited<ReturnType<typeof cdpConnect>> | undefined;
  let origin: string | undefined;
  let listening = false;
  try {
    await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
    listening = true;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("phase6_browser_loopback_bind_failed");
    origin = `http://127.0.0.1:${address.port}`;
    chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const browserSocket = await new Promise<string>((resolveSocket, rejectSocket) => {
      const timeout = setTimeout(() => rejectSocket(new Error("phase6_browser_debug_timeout")), 20_000);
      chrome!.stderr?.on("data", (chunk) => { const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match?.[1]) { clearTimeout(timeout); resolveSocket(match[1]); } });
    });
    const endpoint = new URL(browserSocket);
    const target = await fetch(`http://${endpoint.host}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>);
    if (!target.webSocketDebuggerUrl) throw new Error("phase6_browser_target_missing");
    client = await cdpConnect(target.webSocketDebuggerUrl);
    await client.call("Runtime.enable");
    await client.call("Page.enable");
    await client.call("Page.navigate", { url: origin });
    let pageReady = false;
    for (let attempt = 0; attempt < 100 && !pageReady; attempt += 1) {
      const ready = await client.call("Runtime.evaluate", { expression: "document.readyState === 'complete' && typeof EmailChangeCarrierModule?.createEmailChangeVerificationCarrier === 'function'", returnByValue: true });
      pageReady = ready.result?.result?.value === true;
      if (!pageReady) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (!pageReady) throw new Error("phase6_browser_page_not_ready");
    const secret = randomBytes(32).toString("base64url");
    const carrier = await client.call("Runtime.evaluate", { expression: `(async()=>{const carrier=EmailChangeCarrierModule.createEmailChangeVerificationCarrier();let attempts=0;try{await carrier.submit(${JSON.stringify(secret)},async()=>{attempts+=1;throw new Error('lost_response')})}catch{}const replay=await carrier.submit(${JSON.stringify(secret)},async()=>{attempts+=1;return{status:'verified'}});const databases=indexedDB.databases?await indexedDB.databases():[];const cacheKeys='caches'in globalThis?await caches.keys():[];return{attempts,replay,active:carrier.hasActiveSecret(),url:location.href,html:document.documentElement.outerHTML,storageValues:[...Object.values(localStorage),...Object.values(sessionStorage)],databases,cacheKeys}})()`, awaitPromise: true, returnByValue: true });
    const result = carrier.result?.result?.value as { attempts?: number; replay?: { status?: string }; active?: boolean; url?: string; html?: string; storageValues?: string[]; databases?: unknown[]; cacheKeys?: string[] } | undefined;
    const serialized = JSON.stringify(result ?? {});
    const invalid = !result || result.attempts !== 2 || result.replay?.status !== "verified" || result.active !== false || serialized.includes(secret) || result.url?.includes(secret) || result.html?.includes(secret) || result.storageValues?.some((value) => value.includes(secret)) || Boolean(result.databases?.length) || Boolean(result.cacheKeys?.length);
    if (invalid) throw new Error("phase6_browser_secret_retention_or_replay_invalid");
    if (applicationOrigin) {
      await client.call("Page.navigate", { url: `${applicationOrigin}/` });
      let applicationResult: { emitted?: string; confirmed?: string; failed?: string; storageCount?: number } | undefined;
      for (let attempt = 0; attempt < 200 && !applicationResult; attempt += 1) {
        const response = await client.call("Runtime.evaluate", { expression: "window.p13EmailChangeResult", returnByValue: true });
        applicationResult = response.result?.result?.value as typeof applicationResult;
        if (!applicationResult) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (applicationResult?.emitted !== "issued" || applicationResult.confirmed !== "confirmed" || applicationResult.failed !== "signed_out" || applicationResult.storageCount !== 0) throw new Error("phase6_browser_better_auth_cookie_flow_invalid");
    }
    console.log("P1_3_EMAIL_CHANGE_BROWSER_ACCEPTANCE_PASS");
    await runSignInAcceptance(client, origin);
    await runSessionManagerAcceptance(client, origin);
    await runSecurityHistoryAcceptance(client, origin);
  } finally {
    client?.close();
    let cleanupError: Error | undefined;
    if (chrome) {
      try { await terminateChrome(chrome); } catch (error) { cleanupError = error instanceof Error ? error : new Error("phase7_browser_chrome_cleanup_incomplete"); }
    }
    if (listening) {
      try { await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())); } catch (error) { cleanupError ??= error instanceof Error ? error : new Error("phase7_browser_server_cleanup_incomplete"); }
    }
    if (origin) {
      const reachable = await fetch(origin).then(() => true).catch(() => false);
      if (reachable) cleanupError ??= new Error("phase7_browser_server_cleanup_incomplete");
    }
    rmSync(runRoot, { recursive: true, force: true });
    if (existsSync(runRoot)) cleanupError ??= new Error("phase7_browser_profile_or_bundle_cleanup_incomplete");
    if (cleanupError) throw cleanupError;
    console.log("P1_3_EMAIL_CHANGE_BROWSER_ACCEPTANCE_CLEANUP_PASS");
    console.log("P1_3_SESSION_MANAGER_BROWSER_ACCEPTANCE_CLEANUP_PASS");
    console.log("P1_3_SECURITY_HISTORY_BROWSER_ACCEPTANCE_CLEANUP_PASS");
    console.log("P1_3_SIGN_IN_BROWSER_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("p1-3-email-change-browser.acceptance-rehearsal.ts")) runP13EmailChangeBrowserAcceptance().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "phase6_browser_failed"}\n`); process.exitCode = 1; });
