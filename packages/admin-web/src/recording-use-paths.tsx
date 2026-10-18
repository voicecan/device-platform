import { useState } from 'react';
import { recordingTask } from './recording-task.js';
import { Button } from './ui.js';

const task = recordingTask({mode:'download'});
export function RecordingUsePaths({method,onChange,onCreateApplication}:{method:string;onChange:(value:string)=>void;onCreateApplication:()=>void}) {
  const [copied,setCopied]=useState('');
  return <section className="content-card recording-use-paths"><h2><span className="heading-phrase">拿到录音，</span><wbr/><span className="heading-phrase">接下来怎么用？</span></h2><p>平台负责连接设备、同步和保存录音。选择你熟悉的工具，去做课程笔记、会议总结或自己的应用。</p>
    <div className="ai-client-grid" role="group" aria-label="选择录音使用方式">{[
      ['download','先下载一条录音','偶尔处理录音，最容易开始'],['ai','连接我的 AI 工具','让 Codex、WorkBuddy 或 OpenClaw 持续读取录音'],['app','接入自己的应用','用 API 获取录音，自己决定如何处理']
    ].map(([id,title,description])=><button key={id} className={`ai-client ${method===id?'is-selected':''}`} aria-pressed={method===id} onClick={()=>onChange(id!)}><strong>{title}</strong><small>{description}</small></button>)}</div>
    {method==='download'?<div className="ai-step"><h3>先用一条录音试一试</h3><ol><li>打开录音列表，按设备找到已同步完成的录音并下载。</li><li>把文件放到 Codex、WorkBuddy 的工作目录，或导入支持音频的应用；课本、讲义也可以一起放入。</li><li>告诉工具你想做什么。原始录音可能是 LC3 或 bin 文件，需要先解码再转写；不能只改文件后缀。首次建议录一段 30–60 秒的清晰语音试用。</li></ol><a className="button" href="/admin?view=files">去录音列表</a><p>可以复制这段话开始：</p><blockquote>请把我下载的录音转成文字，按时间戳整理要点；没有可靠语音就明确告诉我。</blockquote><details><summary>查看发送给 AI 的完整任务</summary><p>{task}</p></details><Button kind="secondary" onClick={()=>{void navigator.clipboard.writeText(task).then(()=>setCopied('已复制，可粘贴到你的 AI 工具。'),()=>setCopied('复制失败，请选中文字手动复制。'));}}>复制任务描述</Button><p role="status">{copied}</p></div>:null}
    {method==='app'?<div className="ai-step"><h3>让自己的应用获取录音</h3><p>不需要 MCP。创建应用授权后，通过 REST API 获取录音；需要自动处理新录音时，再配置 Webhook。</p><ol><li>选择允许访问的设备分组，创建应用授权。</li><li>查询录音列表，为选中的录音申请临时下载链接。</li><li>在自己的服务中下载并处理音频，接入自己的转写或模型 API。</li></ol><Button onClick={onCreateApplication}>创建应用授权</Button><p className="hint">应用密钥保存在你的服务端；临时下载链接用完即弃。授权管理中可查看接入配置和撤销权限。</p></div>:null}
    {method==='ai'?<p className="hint">MCP 是让 AI 工具读取录音的连接方式。只需配置一次；转写和内容生成在你选择的工具中完成。</p>:null}
  </section>;
}
export function RemoteMcpGuide({client,url}:{client:string;url:string}) {
  const [notice,setNotice]=useState('');
  let usable=false;
  try {const parsed=new URL(url);usable=parsed.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);}catch{/* Wait for server metadata. */}
  return <section className="ai-step ai-remote"><h3>连接云端或另一台电脑上的平台</h3><p>在运行 AI 工具的电脑上添加下面的服务地址，随后登录平台、选择设备分组并确认权限。无需复制这台电脑上的文件或管理员密码。</p>
    <FieldValue value={url||'正在读取服务器地址…'} />
    {!usable?<div role="status" className="inline-alert"><strong>先让服务器提供可访问的 HTTPS 地址</strong><p>当前地址仅适合本机或尚未配置 HTTPS，不能直接作为云端接入地址。请服务器管理员配置域名、HTTPS 和平台公开地址，再回到本页。开放一个端口不代表已经能安全连接。</p><details><summary>服务器管理员配置说明</summary><p>将 VOICECAN_PUBLIC_BASE_URL 设置为平台实际的 HTTPS 入口，并配置反向代理转发 /mcp、/oauth 和 /.well-known 路径。重启服务后本页会显示新地址。远程电脑还需能访问该地址。</p></details></div>:<><Button kind="secondary" onClick={()=>{void navigator.clipboard.writeText(url).then(()=>setNotice('服务地址已复制。'),()=>setNotice('复制失败，请手动复制地址。'));}}>复制 MCP 服务地址</Button><ol><li>{client==='workbuddy'?'在 WorkBuddy 的设置或插件中打开 MCP 服务器，添加远程服务。':client==='openclaw'?'在 OpenClaw 的 Settings → MCP 中添加服务器。':'在工具的 MCP 设置中添加远程服务器。'}</li><li>填入上方地址，传输方式选择 Streamable HTTP，认证选择 OAuth。</li><li>按提示打开授权页面，登录平台，选择设备分组。要处理音频，请确认授权包含录音下载权限。</li><li>回到工具检查连接与可用工具，再让它列出录音。只有工具实际读取成功，才算接入完成。</li></ol><p className="hint">地址已配置不代表网络已验证；连接状态请以 AI 工具的实际检测为准。若版本不支持远程 OAuth，可升级客户端，或先下载录音使用。</p></>}
    {['workbuddy','openclaw'].includes(client)?<a href={client==='workbuddy'?'https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide':'https://docs.openclaw.ai/tools/mcp'} target="_blank" rel="noopener noreferrer">{client==='workbuddy'?'WorkBuddy': 'OpenClaw'} 官方接入说明 ↗</a>:null}<p role="status">{notice}</p>
  </section>;
}
function FieldValue({value}:{value:string}) {return <pre aria-label="MCP 服务地址"><code>{value}</code></pre>;}

export function RecordingProcessingHelp(){return <details className="ai-config-details"><summary>能看到录音，为什么还不能总结？</summary><dl><dt>只有列表权限</dt><dd>列表只包含文件信息。回到连接设置选择录音读取，确认授权，再打开新的 AI 对话。</dd><dt>下载的是 bin 或 LC3 文件</dt><dd>这是原始录音，未必能直接播放。让工具检查文件头、使用兼容解码器转为 WAV，再进行转写；只改后缀无效。</dd><dt>工具缺少解码器或转写能力</dt><dd>让工具列出缺少项和安装步骤。可使用本地离线工具，或由你选择转写服务；MCP 连接本身不包含转写模型。</dd><dt>转写为空或像乱码</dt><dd>先检查音量、噪声和解码结果，再判断识别工具是否适合。换一条清晰录音验证；尚未识别出可靠语音时，不应生成看似完整的总结。</dd></dl></details>;}
