export type RecordingTaskOptions = { mode: 'download' | 'metadata' | 'recordings'; recordingId?: string; serverName?: string };
/** Instructions contain resource IDs only, never credentials or temporary download URLs. */
export function recordingTask({mode,recordingId,serverName}:RecordingTaskOptions):string {
  if(mode==='download') return '请处理我放在当前工作目录中的录音文件，不需要连接设备平台。先列出本地音频让我选择；检查格式、解码器和转写工具。bin 扩展名不代表文件损坏，也不能直接当作 WAV。若缺少工具，明确告诉我缺什么、下一步怎么做；不要只重复“需要转写”。优先用已安装的本地工具；上传到外部转写服务前先征得我同意。转写后按时间戳总结主题、要点与待办；本机转写没有可靠语音时，区分录音质量与识别工具问题，明确说明无法总结，不编造课程或会议内容。课本和讲义仅作为独立资料引用。';
  const source=serverName?`请使用 ${serverName} 这份 MCP 连接。`:'请使用已授权的 Voicecan 录音 MCP。';
  if(mode==='metadata') return source+'只查询设备和录音列表，不申请下载链接，也不声称已经读取音频或完成总结。若我要总结，请提示回平台选择“读取录音，用于后续处理”并完成授权。';
  return source+(recordingId?`处理录音 ID ${JSON.stringify(recordingId)}，先调用 recordings.get 确认来源和状态，不批量下载其他录音。`:'按设备和日期列出已同步录音，让我选一条；首次试用优先选择较短且有语音的录音。')+'检查 media 与本机解码、转写能力后，再申请临时下载链接。流式下载一次，校验大小和 SHA-256，不把链接或密钥写入文档、日志或命令历史，用完撤销链接。格式未知时按平台文档的 LC3 默认路径检查文件头并验证解码，失败就停止；不能仅把 bin 改名为 wav。优先使用本机已有的离线转写工具，上传录音到其他服务前先征得我同意。转写结果保留时间戳，然后总结主题、关键点与明确的待办。听不清或没有可靠语音时，说明无法总结并建议换一条或录一段测试语音；不要补造内容。将来源 ID、转写和总结保存在当前工作目录中。';
}
