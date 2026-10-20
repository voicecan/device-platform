import { useEffect, useState } from 'react';
import { RecordingProcessingHelp, RecordingUsePaths, RemoteMcpGuide } from './recording-use-paths.js';
import { recordingTask } from './recording-task.js';
import { ApiError } from './api-error.js';
import { api, errorMessage } from './api.js';
import { Button, collectionOf, Field, Select } from './ui.js';
import type { Translate } from './ui.js';

type Plan = { installation?: string | null; verified_tools?: number | null; client: string; configuration: string; install_command: string | null; verify_command?: string | null; server_name: string; expires_at: string };
type Group = { id: string; name: string };
const clients = ['openclaw', 'codex', 'workbuddy', 'claude', 'generic'] as const;
const names: Record<string, string> = { workbuddy: 'WorkBuddy', openclaw: 'OpenClaw', codex: 'Codex', claude: 'Claude Desktop', generic: 'Other MCP client' };
export function McpQuickStart({ t, onAdvanced, onCreateApplication }: { t: Translate; onAdvanced: () => void; onCreateApplication: (groupId: string) => void }) {
  const [method, setMethod] = useState('download');
  const [mcpUrl, setMcpUrl] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [client, setClient] = useState('openclaw');
  const [location, setLocation] = useState('local');
  const [access, setAccess] = useState('recordings');
  const [consent, setConsent] = useState(false);
  const [available, setAvailable] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<Plan>();
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void Promise.all([api('/user-groups'), api<{available:boolean;can_install:boolean;mcp_url?:string}>('/open-platform/mcp-quick-connect')]).then(([data, status]) => {
      if (!active) return;
      const list = collectionOf(data).map((g) => ({id:String(g.id),name:String(g.name)}));
      setGroups(list); setGroupId((old) => list.some((g) => g.id === old) ? old : list.length === 1 ? list[0]!.id : '');
      setMcpUrl(status.mcp_url ?? ''); setAvailable(status.available); setCanInstall(status.can_install); setLoading(false);
    }, (cause) => { if(active) {setError(errorMessage(cause));setLoading(false);} });
    return () => {active=false;};
  }, [attempt]);
  const reset = () => {setPlan(undefined);setNotice('');setError('');setConsent(false);};
  const generate = async (install: boolean) => {
    if (busy || !groupId || !available || location !== 'local' || !consent) return;
    setBusy(true);setError('');setNotice('');setPlan(undefined);
    try { setPlan(await api<Plan>('/open-platform/mcp-quick-connect',{method:'POST',body:JSON.stringify({group_id:groupId,client,access,consent,install})})); }
    catch(cause){const code=cause instanceof ApiError?cause.code:'';const messages:Record<string,string>={MCP_CONNECTION_INACTIVE:'This authorization expired or was revoked. Review it in Connection management.',MCP_CONNECTION_CHANGED:'This authorization changed. Review it in Connection management.',MCP_CREDENTIAL_FILE_MISSING:'The local credential file is missing. Review this connection in Connection management.',CODEX_CLI_NOT_FOUND:'Install the Codex CLI, or use manual configuration.',MCP_NAME_CONFLICT:'A different connection already uses this name. Existing settings were not overwritten.',RECORDING_CONSENT_REQUIRED:'Confirm recording content access before continuing.'};setError(messages[code]?`${t(messages[code]!)} [${code}]`:errorMessage(cause));} finally{setBusy(false);}
  };
  const copy = async (value:string) => {try{await navigator.clipboard.writeText(value);setNotice(t('Copied. Complete the next step in your AI tool.'));}catch{setNotice(t('Copy failed. Select and copy the text below.'));}};
  const prompt = recordingTask({mode:access==='recordings'?'recordings':'metadata',...(plan?{serverName:plan.server_name}:{})});
  return <><RecordingUsePaths method={method} onChange={setMethod} onCreateApplication={()=>onCreateApplication(groupId)} />{method==='ai'?<div className="ai-connect-layout">
    <section className="content-card ai-connect-main" aria-busy={loading || busy}>
      <header className="ai-section-heading"><div><h2>{t('Bring your recordings to your AI tool')==='让你的 AI 工具用上录音'?<><span className="heading-phrase">让你的 AI 工具</span><wbr/><span className="heading-phrase">用上录音</span></>:t('Bring your recordings to your AI tool')}</h2><p>{t('The platform stores recordings. Your AI tool handles transcription, notes and other tasks.')}</p></div><span className="ai-protocol">MCP</span></header>
      {loading ? <p role="status">{t('Loading connection options…')}</p> : <>
        <fieldset className="ai-step" disabled={busy}><legend><span>1</span>{t('Choose your AI tool')}</legend>
          <div className="ai-client-grid">{clients.map((id)=><label className={`ai-client ${client===id?'is-selected':''}`} key={id}><input type="radio" name="ai-client" value={id} checked={client===id} onChange={()=>{setClient(id);reset();}}/><strong>{t(names[id]!)}</strong><small>{t(id==='openclaw'?'Connect your OpenClaw agent':id==='codex'?'Use recordings in your coding workspace':id==='claude'?'Connect the desktop app':'Use a compatible MCP client')}</small></label>)}</div>
          <Field id="ai-location" label={t('Where does your AI tool run?')}><Select id="ai-location" value={location} onChange={(v)=>{setLocation(v);reset();}} options={[{value:'local',label:t('On this server computer')},{value:'remote',label:t('On another computer or cloud server')}]}/></Field>
        </fieldset>
        {location==='remote' || !available ? <RemoteMcpGuide client={client} url={mcpUrl} access={access} onAccess={(value)=>{setAccess(value);reset();}} localBlocked={location==='local'} /> : <>
        <fieldset className="ai-step" disabled={busy}><legend><span>2</span>{t('Choose what it can access')}</legend>
          <Field id="ai-group" label={t('Device group')}><Select id="ai-group" value={groupId} onChange={(v)=>{setGroupId(v);reset();}} placeholder={t('Choose a group')} options={groups.map((g)=>({value:g.id,label:g.name}))}/></Field>
          <p className="hint">{t('Access covers all recordings in this group, including recordings added later.')}</p><p className="hint">{access==='recordings'?'要转写或总结，请选择录音读取，并在下方确认授权。':'仅查看列表不能转写或总结；需要处理内容时请选择录音读取。'}</p>
          <div className="ai-access-options"><label><input type="radio" name="ai-access" checked={access==='metadata'} onChange={()=>{setAccess('metadata');reset();}}/><span><strong>{t('Browse recording lists')}</strong><small>{t('See device status and recording metadata. Audio cannot be downloaded.')}</small></span></label><label><input type="radio" name="ai-access" checked={access==='recordings'} onChange={()=>{setAccess('recordings');reset();}}/><span><strong>{t('Read and process recordings')}</strong><small>{t('Also create temporary audio download links. No device control or deletion permissions.')}</small></span></label></div>
          <label className="ai-consent"><input type="checkbox" checked={consent} onChange={(e)=>setConsent(e.target.checked)}/><span>{t(access==='recordings'?'I authorize this connection to read and download recordings in the selected group.':'I authorize this connection to query device and recording metadata in the selected group.')}</span></label>
        </fieldset>
        <section className="ai-step"><h3><span>3</span>{t('Add the connection')}</h3><p>{t(client==='openclaw'?'Generate the configuration, then run the command in Terminal on the computer running OpenClaw.':client==='codex'?'Add the connection to Codex on this computer, then open a new chat.':'Generate the configuration and add the server entry in your client settings.')}</p>
          <div className="form-actions"><Button disabled={busy || !consent || !groupId} onClick={()=>void generate(client==='codex'&&canInstall)}>{t(busy?'Preparing connection…':client==='codex'&&canInstall?'Add to Codex':'Generate connection configuration')}</Button>{client==='codex'&&canInstall?<Button kind="ghost" disabled={busy||!consent||!groupId} onClick={()=>void generate(false)}>{t('Manual configuration')}</Button>:null}</div>
          <p className="hint">{t('Credentials stay in a private file on this computer. You can revoke access in Connection management.')}</p>
        </section>
        </>}
      </>}
      {error?<div role="alert" className="inline-alert inline-alert-error"><p>{error}</p><p>{t('Setup did not complete. Existing client settings are preserved.')}</p>{!groups.length?<Button kind="secondary" onClick={()=>setAttempt((v)=>v+1)}>{t('Try again')}</Button>:null}</div>:null}
      {plan?<section className="ai-result" aria-label={t('Connection configuration')}>
        <h3>{t(plan.installation?'Codex configuration installed':'Configuration ready — client connection not yet verified')}</h3>
        <p>{plan.installation?t('The local MCP responded with {count} tools. Open a new Codex chat; this does not verify audio processing.',{count:plan.verified_tools??0}):t('Run the setup and check steps below. Generating or copying configuration does not mean your AI tool has connected.')}</p>
        {plan.install_command&&!plan.installation?<><h4>{t('Run in Terminal')}</h4><pre><code>{plan.install_command}</code></pre><Button kind="secondary" onClick={()=>void copy(plan.install_command!)}>{t('Copy setup command')}</Button></>:null}
        {plan.verify_command?<><h4>{t('Check from OpenClaw')}</h4><pre><code>{plan.verify_command}</code></pre><Button kind="secondary" onClick={()=>void copy(plan.verify_command!)}>{t('Copy verification command')}</Button><p>{t('Stop the OpenClaw Gateway before add, login, or doctor --probe. Those commands need an exclusive config lock and fail while the Gateway is running. Start it again after the check. A successful probe lists tools; it does not transcribe audio.')}</p><a href="https://docs.openclaw.ai/tools/mcp" target="_blank" rel="noopener noreferrer">{t('OpenClaw connection guide')} ↗</a></>:null}
        {plan.installation?<p role="status">已通过 MCP 握手和录音列表查询。下一步由 Codex 下载选中的音频并检查解码与转写，尚未验证内容处理。</p>:null}<details className="ai-config-details"><summary>{t('View configuration JSON / TOML')}</summary><p>{t('Merge this server entry into your existing configuration; do not replace unrelated settings.')}</p><pre><code>{plan.configuration}</code></pre><Button kind="secondary" onClick={()=>void copy(plan.configuration)}>{t('Copy configuration')}</Button></details>
        {client==='workbuddy'?<p>在 WorkBuddy 打开「插件 → MCP 服务器 → 配置 MCP」，将下方 mcpServers 条目合并到现有配置，保存后检查连接状态。不同版本入口可能位于设置中。</p>:null}<h4>{t('Then try this in your AI tool')}</h4>{client==='codex'?<ol><li>新建一个 Codex 对话，打开用于保存录音和笔记的本地文件夹。</li><li>粘贴下方任务描述。已有对话可能需要重新打开，才能加载新连接。</li><li>Codex 会先查询录音，再检查解码和转写能力；未找到工具时，应显示缺少项和下一步。</li></ol>:null}<blockquote>{access==='recordings'?'列出已同步的录音，让我选一条；转写后按时间戳整理要点和明确的待办。':'列出我有权查看的设备和录音信息。'}</blockquote><details><summary>查看发送给 AI 的完整任务</summary><p>{prompt}</p></details><Button kind="ghost" onClick={()=>void copy(prompt)}>{t('Copy first task')}</Button>
      </section>:null}
      <RecordingProcessingHelp />{notice?<p role="status" className="ai-notice">{notice}</p>:null}
    </section>
    <aside className="ai-connect-aside"><section><h3>{t('Your first recording, ready to use')}</h3><ol><li>{t('Add your device with Bluetooth and Wi-Fi.')}</li><li>{t('Make a recording and wait for synchronization.')}</li><li>{t('Connect your AI tool and choose a recording.')}</li></ol><a href="/admin?view=files">{t('View recordings')} →</a></section><section><h3>{t('What happens to my audio?')}</h3><p>{t('This platform does not transcribe or summarize. Your AI tool may need an audio decoder and a transcription service. Choose where the audio is processed in that tool.')}</p></section><details><summary>{t('Develop your own application')}</summary><p>{t('Use REST and Webhooks independently of MCP. Example applications are optional.')}</p><Button kind="ghost" onClick={()=>onCreateApplication(groupId)}>{t('Create application authorization')}</Button><a href="http://127.0.0.1:18915/study" target="_blank" rel="noopener noreferrer">{t('Explore example demo')} ↗</a></details><Button kind="ghost" onClick={onAdvanced}>{t('Connection management')}</Button></aside>
  </div>:null}</>;
}
