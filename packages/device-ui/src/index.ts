import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import type { ProvisioningResult, TransferOutBroker, VoicecanDeviceClient } from '@voicecan/device-web';
import { deviceUiText, normalizeDeviceUiLocale, type DeviceUiLocale } from './i18n.js';

type SelectedDevice = Awaited<ReturnType<VoicecanDeviceClient['requestDevice']>>;
type ConnectedDeviceInfo = ProvisioningResult['deviceInfo'] & { hardwareVersion?: string };
type ConnectedDeviceStatus = Awaited<ReturnType<SelectedDevice['getStatus']>>;

const sharedStyles = css`
  :host { display: block; color: var(--vc-text, var(--voicecan-text, #272622)); font: 14px/1.55 Inter, "PingFang SC", ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  .card { position: relative; overflow: hidden; border: 1px solid var(--vc-border, var(--voicecan-border, #e3e0d9)); border-radius: var(--vc-radius-lg, 18px); padding: clamp(22px, 4vw, 34px); background: var(--vc-surface, var(--voicecan-surface, #fff)); box-shadow: var(--vc-shadow-soft, 0 1px 2px rgb(42 39 34 / 4%), 0 12px 36px rgb(70 64 54 / 7%)); }
  .card::before { position: absolute; inset: 0 0 auto; height: 1px; background: linear-gradient(90deg, transparent, rgb(255 255 255 / 90%), transparent); content: ''; }
  .card.compact-status-card { overflow: visible; border: 0; border-radius: 0; padding: 0; background: transparent; box-shadow: none; }
  .card.compact-status-card::before { display: none; }
  .compact-status { display: flex; min-height: 0; align-items: center; gap: 8px; margin: 0; padding: 9px 2px; color: var(--vc-muted, var(--voicecan-muted, #75716a)); font-size: 11px; }
  .compact-status::before { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #7d9b91; content: ''; }
  .heading { display: flex; align-items: flex-start; gap: 13px; margin-bottom: 24px; }
  .heading-icon { display: grid; width: 43px; height: 43px; flex: 0 0 auto; place-items: center; border: 1px solid #d6dfde; border-radius: 14px; background: linear-gradient(145deg, #f8faf8, #e4ecea); color: var(--vc-primary, #466873); font-size: 19px; }
  h2 { margin: 0 0 5px; font-size: 22px; font-weight: 620; letter-spacing: -.025em; }
  h3 { margin: 0 0 6px; font-size: 18px; font-weight: 620; letter-spacing: -.02em; }
  p { margin: 0; color: var(--vc-muted, var(--voicecan-muted, #75716a)); }
  .heading p { font-size: 12px; }
  .stepper { display: grid; grid-template-columns: repeat(var(--step-count, 4), minmax(0, 1fr)); margin: 0 0 28px; padding: 0; list-style: none; }
  .stepper li { position: relative; display: flex; align-items: center; gap: 7px; color: #a09b93; font-size: 10px; font-weight: 650; }
  .stepper li:not(:last-child)::after { position: absolute; z-index: 0; top: 50%; right: 8px; left: 28px; height: 1px; background: var(--vc-border, #e3e0d9); content: ''; }
  .stepper li > span:last-child { z-index: 1; padding-right: 6px; background: #fff; }
  .stepper li.done:not(:last-child)::after { background: #9eb8b1; }
  .marker { z-index: 1; display: grid; width: 24px; height: 24px; flex: 0 0 auto; place-items: center; border: 1px solid var(--vc-border, #e3e0d9); border-radius: 50%; background: #fff; font-size: 9px; }
  .current { color: var(--vc-primary, #466873) !important; }
  .current .marker { border-color: var(--vc-primary, #466873); box-shadow: 0 0 0 5px rgb(70 104 115 / 8%); }
  .done { color: var(--vc-success, #4e7a68) !important; }
  .done .marker { border-color: var(--vc-success, #4e7a68); background: var(--vc-success, #4e7a68); color: #fff; }
  .stage { min-height: 230px; animation: stage-in 220ms cubic-bezier(.2,.8,.2,1); }
  @keyframes stage-in { from { opacity: 0; transform: translateY(6px); } }
  .stage-copy { margin-bottom: 20px; }
  .stage-copy p { max-width: 620px; font-size: 12px; }
  form, .fields { display: grid; gap: 15px; }
  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
  label { display: grid; gap: 6px; color: #48453f; font-size: 12px; font-weight: 650; }
  label.wide { grid-column: 1 / -1; }
  small { color: var(--vc-muted, #75716a); font-size: 10px; font-weight: 400; }
  input, select { width: 100%; min-height: 44px; border: 1px solid var(--vc-input-border, var(--voicecan-input-border, #d4d0c7)); border-radius: 12px; padding: 9px 12px; background: #fff; color: inherit; font: inherit; transition: border-color 160ms, box-shadow 160ms; }
  input:focus, select:focus { border-color: var(--vc-primary, #466873); box-shadow: 0 0 0 4px rgb(70 104 115 / 10%); outline: 0; }
  input[aria-invalid='true'] { border-color: var(--vc-danger, #b94b48); box-shadow: 0 0 0 4px rgb(185 75 72 / 9%); }
  .field-error { color: var(--vc-danger, #b94b48); font-size: 11px; font-weight: 550; }
  .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 5px; }
  button { min-height: 42px; border: 1px solid transparent; border-radius: 12px; padding: 9px 16px; background: var(--vc-primary, var(--voicecan-primary, #466873)); color: #fff; cursor: pointer; font: inherit; font-weight: 650; transition: transform 160ms cubic-bezier(.2,.8,.2,1), background 160ms, box-shadow 160ms; }
  button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 7px 20px rgb(70 104 115 / 16%); }
  button.secondary { border-color: var(--vc-border, #e3e0d9); background: #fff; color: var(--vc-text, #272622); box-shadow: none; }
  button.ghost { background: transparent; color: var(--vc-primary, #466873); }
  button.danger { background: var(--vc-danger, #b94b48); }
  button:disabled { cursor: not-allowed; opacity: .45; }
  .capability { display: flex; align-items: flex-start; gap: 10px; margin: 18px 0; border: 1px solid #d7e2e0; border-radius: 13px; padding: 13px; background: #f2f7f5; color: #45695d; font-size: 11px; }
  .capability.blocked { border-color: #ecc9c7; background: #fff5f4; color: #913e3b; }
  .network-note { display: flex; align-items: flex-start; gap: 10px; margin: -4px 0 18px; border: 1px solid #e7d7b9; border-radius: 13px; padding: 12px 13px; background: #fcf7ed; color: #765f35; font-size: 11px; }
  .network-note strong { display: block; margin-bottom: 2px; color: #5f4b28; }
  .network-skip { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; border-top: 1px solid var(--vc-border, #e3e0d9); padding-top: 16px; }
  .network-skip div { display: grid; gap: 2px; }
  .network-skip strong { color: var(--vc-text, #272622); font-size: 12px; }
  .network-skip span { color: var(--vc-muted, #75716a); font-size: 10px; }
  .network-skip button { flex: 0 0 auto; }
  .network-status { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 18px; border: 1px solid var(--vc-border, #e3e0d9); border-radius: 14px; padding: 14px 15px; background: #fafaf7; }
  .network-status > div { display: grid; gap: 2px; }
  .network-status span { color: var(--vc-muted, #75716a); font-size: 10px; }
  .network-status strong { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }
  .review { display: grid; gap: 10px; margin-bottom: 18px; border: 1px solid var(--vc-border, #e3e0d9); border-radius: 14px; padding: 15px; background: #faf9f6; }
  .review div { display: flex; justify-content: space-between; gap: 15px; }
  .review span { color: var(--vc-muted, #75716a); font-size: 11px; }
  .review strong, .review code { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .progress-visual, .success-visual { display: grid; min-height: 150px; place-items: center; text-align: center; }
  .progress-visual { min-height: 280px; }
  .progress-panel { display: grid; width: min(100%, 440px); justify-items: center; }
  .connection-visual { position: relative; display: grid; width: 132px; height: 132px; margin: 2px 0 27px; place-items: center; isolation: isolate; }
  .connection-visual::before { position: absolute; z-index: -2; inset: 22px; border-radius: 50%; background: radial-gradient(circle, rgb(70 104 115 / 17%) 0, rgb(70 104 115 / 6%) 48%, transparent 72%); content: ''; animation: beacon-glow 2.6s ease-in-out infinite; }
  .connection-orbit { position: absolute; z-index: -1; inset: 12px; border: 1px solid rgb(70 104 115 / 24%); border-top-color: var(--vc-primary, #466873); border-radius: 50%; animation: orbit-turn 7s linear infinite; }
  .connection-orbit::after { position: absolute; top: 7px; right: 13px; width: 7px; height: 7px; border: 2px solid #fff; border-radius: 50%; background: var(--vc-primary, #466873); box-shadow: 0 2px 8px rgb(70 104 115 / 32%); content: ''; }
  .connection-orbit.outer { inset: 0; border-color: rgb(70 104 115 / 12%); border-right-color: rgb(70 104 115 / 42%); animation-duration: 11s; animation-direction: reverse; }
  .connection-orbit.outer::after { top: auto; right: auto; bottom: 15px; left: 14px; width: 5px; height: 5px; background: #8eaaa3; }
  .device-beacon { position: relative; display: grid; width: 52px; height: 70px; place-items: center; border: 1px solid rgb(70 104 115 / 22%); border-radius: 18px; background: linear-gradient(155deg, #fff 4%, #edf3f1 96%); box-shadow: 0 15px 34px rgb(70 104 115 / 18%), inset 0 1px 0 rgb(255 255 255 / 90%); animation: device-float 2.6s ease-in-out infinite; }
  .device-beacon::before { position: absolute; top: 9px; width: 5px; height: 5px; border-radius: 50%; background: #6f9989; box-shadow: 0 0 0 4px rgb(111 153 137 / 10%); content: ''; animation: status-breathe 1.8s ease-in-out infinite; }
  .device-beacon::after { position: absolute; bottom: 8px; width: 13px; height: 2px; border-radius: 99px; background: rgb(70 104 115 / 28%); content: ''; }
  .device-signal { display: flex; height: 21px; align-items: center; justify-content: center; gap: 3px; }
  .device-signal span { width: 3px; border-radius: 99px; background: var(--vc-primary, #466873); animation: signal-wave 1.2s ease-in-out infinite; }
  .device-signal span:nth-child(1), .device-signal span:nth-child(3) { height: 9px; animation-delay: -.35s; }
  .device-signal span:nth-child(2) { height: 19px; animation-delay: -.12s; }
  .progress-copy { display: grid; justify-items: center; gap: 8px; }
  .progress-copy h3 { margin: 0; }
  .progress-status[role='status'] { display: inline-flex; min-height: 34px; align-items: center; gap: 9px; margin: 0; border: 1px solid rgb(70 104 115 / 10%); border-radius: 999px; padding: 6px 13px; background: rgb(70 104 115 / 5%); color: var(--vc-muted, #75716a); font-size: 11px; line-height: 1.45; }
  .progress-status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #6f9989; box-shadow: 0 0 0 0 rgb(111 153 137 / 28%); animation: status-ping 1.8s ease-out infinite; }
  .progress-panel .actions { justify-content: center; margin-top: 22px; }
  .provisioning-device-snapshot { display: inline-flex; max-width: 100%; align-items: center; gap: 7px; margin-top: 12px; color: var(--vc-muted, #75716a); font-size: 10px; }
  .provisioning-device-snapshot strong { overflow: hidden; color: var(--vc-text, #272622); text-overflow: ellipsis; white-space: nowrap; }
  .provisioning-device-snapshot span { color: #b0aca4; }
  .provisioning-monitor { display: grid; min-height: 0; gap: 12px; }
  .monitor-header { display: grid; grid-template-columns: 150px minmax(0, 1fr); align-items: center; gap: 20px; overflow: hidden; border: 1px solid #dce5e2; border-radius: 17px; padding: 15px 20px; background: linear-gradient(135deg, #f8fbfa 0%, #f2f6f4 58%, #faf9f6 100%); }
  .monitor-header .connection-visual { width: 112px; height: 112px; margin: 0 auto; }
  .monitor-header .device-beacon { transform: scale(.9); }
  .monitor-header .progress-copy { justify-items: start; text-align: left; }
  .monitor-header .progress-status[role='status'] { margin-top: 2px; }
  .monitor-kicker { color: #749087; font-size: 9px; font-weight: 760; letter-spacing: .14em; text-transform: uppercase; }
  .waiting-telemetry-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .waiting-telemetry-grid .telemetry-card { min-height: 91px; }
  .telemetry-note { position: relative; z-index: 1; margin-top: 4px; color: var(--vc-muted, #75716a); font-size: 9px; font-weight: 450; line-height: 1.35; }
  .monitor-footer { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--vc-border, #e3e0d9); padding-top: 10px; }
  .monitor-footer .actions { margin: 0; }
  .monitor-footer button { min-height: 34px; padding: 6px 11px; font-size: 10px; }
  @keyframes orbit-turn { to { transform: rotate(1turn); } }
  @keyframes beacon-glow { 0%, 100% { opacity: .62; transform: scale(.92); } 50% { opacity: 1; transform: scale(1.08); } }
  @keyframes device-float { 0%, 100% { transform: translateY(2px); } 50% { transform: translateY(-3px); } }
  @keyframes signal-wave { 0%, 100% { opacity: .48; transform: scaleY(.58); } 50% { opacity: 1; transform: scaleY(1); } }
  @keyframes status-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
  @keyframes status-ping { 0% { box-shadow: 0 0 0 0 rgb(111 153 137 / 28%); } 70%, 100% { box-shadow: 0 0 0 7px rgb(111 153 137 / 0%); } }
  .pulse { position: relative; display: grid; width: 70px; height: 70px; place-items: center; border-radius: 50%; background: linear-gradient(145deg, #f8faf8, #dfe9e6); color: var(--vc-primary, #466873); }
  .pulse::before, .pulse::after { position: absolute; border: 1px solid rgb(70 104 115 / 22%); border-radius: 50%; content: ''; animation: breathe 2.4s ease-in-out infinite; }
  .pulse::before { inset: -15px; }.pulse::after { inset: -30px; animation-delay: -.8s; }
  @keyframes breathe { 0%,100% { opacity: .3; transform: scale(.94); } 50% { opacity: 1; transform: scale(1.04); } }
  .success-mark { display: grid; width: 66px; height: 66px; place-items: center; border-radius: 50%; background: #e7f0eb; color: #4e7a68; font-size: 28px; }
  .success-visual h3 { margin-top: 28px; }
  .device-overview { min-height: 0; }
  .overview-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px; margin-bottom: 18px; }
  .overview-heading .success-mark { width: 48px; height: 48px; font-size: 20px; }
  .overview-heading h3 { margin: 1px 0 3px; }
  .overview-kicker { color: #749087; font-size: 9px; font-weight: 760; letter-spacing: .14em; text-transform: uppercase; }
  .live-badge { display: inline-flex; min-height: 30px; align-items: center; gap: 7px; border: 1px solid #cfe0d9; border-radius: 999px; padding: 5px 10px; background: #f0f7f3; color: #476f60; font-size: 10px; font-weight: 700; white-space: nowrap; }
  .live-badge::before { width: 6px; height: 6px; border-radius: 50%; background: #5f927d; box-shadow: 0 0 0 0 rgb(95 146 125 / 30%); content: ''; animation: status-ping 1.8s ease-out infinite; }
  .overview-main { display: grid; grid-template-columns: minmax(180px, .72fr) minmax(0, 1.28fr); gap: 12px; }
  .identity-card, .telemetry-card, .device-details { border: 1px solid var(--vc-border, #e3e0d9); background: #fafaf7; }
  .identity-card { display: grid; min-height: 178px; align-content: center; justify-items: center; border-radius: 16px; padding: 20px; text-align: center; }
  .device-portrait { position: relative; width: 46px; height: 74px; margin-bottom: 14px; border: 1px solid rgb(70 104 115 / 22%); border-radius: 17px; background: linear-gradient(155deg, #fff, #e8efed); box-shadow: 0 12px 24px rgb(70 104 115 / 14%); }
  .device-portrait::before { position: absolute; top: 10px; left: 50%; width: 5px; height: 5px; border-radius: 50%; background: #6f9989; box-shadow: 0 0 0 4px rgb(111 153 137 / 10%); content: ''; transform: translateX(-50%); }
  .device-portrait::after { position: absolute; bottom: 10px; left: 50%; width: 14px; height: 2px; border-radius: 99px; background: rgb(70 104 115 / 28%); content: ''; transform: translateX(-50%); }
  .identity-card strong { font-size: 15px; letter-spacing: -.015em; }
  .identity-card code { margin-top: 3px; color: var(--vc-muted, #75716a); font-size: 10px; }
  .telemetry-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .telemetry-card { position: relative; display: grid; min-height: 83px; align-content: space-between; overflow: hidden; border-radius: 15px; padding: 13px 14px; }
  .telemetry-card::after { position: absolute; right: -18px; bottom: -22px; width: 58px; height: 58px; border-radius: 50%; background: rgb(70 104 115 / 4%); content: ''; }
  .telemetry-label { color: var(--vc-muted, #75716a); font-size: 10px; }
  .telemetry-value { display: flex; align-items: center; gap: 7px; color: var(--vc-text, #272622); font-size: 13px; font-weight: 700; }
  .telemetry-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #9b9b94; }
  .telemetry-dot.online { background: #5f927d; box-shadow: 0 0 0 4px rgb(95 146 125 / 9%); }
  .telemetry-dot.recording { background: #b95d55; box-shadow: 0 0 0 4px rgb(185 93 85 / 9%); animation: status-breathe 1.4s ease-in-out infinite; }
  .battery-track { width: 44px; height: 5px; overflow: hidden; border-radius: 99px; background: #e1e4df; }
  .battery-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #88aa9d, #557e70); transition: width 280ms ease; }
  .device-details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 12px; border-radius: 15px; padding: 13px 4px; }
  .device-detail { min-width: 0; padding: 0 12px; }
  .device-detail + .device-detail { border-left: 1px solid var(--vc-border, #e3e0d9); }
  .device-detail span { display: block; margin-bottom: 3px; color: var(--vc-muted, #75716a); font-size: 9px; }
  .device-detail strong, .device-detail code { display: block; overflow: hidden; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .overview-footer { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
  .live-meta { display: inline-flex; min-height: 22px; align-items: center; gap: 7px; margin: 0; color: var(--vc-muted, #75716a); font-size: 10px; }
  .live-meta::before { width: 5px; height: 5px; border-radius: 50%; background: #7d9b91; content: ''; }
  .live-meta.refreshing::before { animation: status-breathe .8s ease-in-out infinite; }
  .overview-footer button { min-height: 34px; padding: 6px 11px; font-size: 10px; }
  .live-error { margin-top: 8px; border-radius: 10px; padding: 8px 10px; background: #fff5f4; color: #913e3b; font-size: 10px; text-align: left; }
  [role='status'] { min-height: 22px; margin-top: 16px; color: var(--vc-muted, #75716a); font-size: 11px; white-space: pre-wrap; }
  .console-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 20px; }
  .console-actions button { display: flex; align-items: center; justify-content: flex-start; background: #f8f7f4; color: var(--vc-text, #272622); font-weight: 600; }
  .console-actions button:hover:not(:disabled) { background: #f0eee9; box-shadow: none; }
  pre { max-height: 260px; overflow: auto; margin: 0; border-radius: 12px; padding: 13px; background: #292b2a; color: #e8ebe8; font-size: 10px; white-space: pre-wrap; }
  .ack { display: flex; align-items: flex-start; gap: 10px; border: 1px solid #ead7bd; border-radius: 13px; padding: 13px; background: #fbf4e9; }
  .ack input { width: 16px; min-height: 16px; accent-color: var(--vc-primary, #466873); }
  .ack span { display: grid; }
  @media (max-width: 640px) { .form-grid, .console-actions, .overview-main { grid-template-columns: 1fr; } label.wide { grid-column: auto; } .stepper li { flex-direction: column; text-align: center; } .stepper li span:last-child { display: none; } .stepper li:not(:last-child)::after { top: 12px; right: -50%; left: 50%; } .network-skip { align-items: stretch; flex-direction: column; } .progress-visual { min-height: 260px; } .connection-visual { width: 118px; height: 118px; margin-bottom: 24px; } .monitor-header { grid-template-columns: 1fr; gap: 4px; padding: 13px 15px 16px; } .monitor-header .connection-visual { width: 98px; height: 98px; margin-bottom: 2px; } .monitor-header .progress-copy { justify-items: center; text-align: center; } .waiting-telemetry-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .monitor-footer { align-items: stretch; flex-direction: column; } .monitor-footer .actions button { width: 100%; } .overview-heading { grid-template-columns: auto 1fr; align-items: start; } .overview-heading .live-badge { grid-column: 1 / -1; justify-self: start; } .identity-card { min-height: 156px; } .device-details { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 12px; } .device-detail:nth-child(3) { border-left: 0; } .device-detail:nth-child(n+3) { border-top: 1px solid var(--vc-border, #e3e0d9); padding-top: 11px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
`;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatStorageCapacity(kilobytes: number, locale: DeviceUiLocale): string {
  const value = kilobytes >= 1_048_576 ? kilobytes / 1_048_576 : kilobytes / 1_024;
  const unit = kilobytes >= 1_048_576 ? 'GB' : 'MB';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

export class VoicecanProvisionerElement extends LitElement {
  static properties = {
    locale: { type: String, reflect: true, noAccessor: true },
    compact: { type: Boolean, reflect: true },
    client: { attribute: false },
    provisioningGrant: { attribute: false, noAccessor: true },
    selectedDevice: { attribute: false },
    statusMessage: { state: true },
    busy: { state: true },
    step: { state: true },
    networkError: { state: true },
    deviceId: { state: true },
    deviceInfo: { state: true },
    deviceStatus: { state: true },
    deviceLinkOnline: { state: true },
    serverOnline: { state: true },
    statusUpdatedAt: { state: true },
    statusRefreshing: { state: true },
    liveStatusError: { state: true },
  };
  static styles = sharedStyles;

  #locale: DeviceUiLocale = 'en';
  get locale(): DeviceUiLocale { return this.#locale; }
  set locale(value: DeviceUiLocale | string) { const next = normalizeDeviceUiLocale(value); const previous = this.#locale; if (next !== previous) { this.#locale = next; this.requestUpdate('locale', previous); } }
  declare compact: boolean;
  declare client?: VoicecanDeviceClient;
  declare selectedDevice: SelectedDevice | undefined;
  declare protected statusMessage: string;
  declare protected busy: boolean;
  declare protected step: number;
  declare protected networkError: string;
  declare protected deviceId: string;
  declare protected deviceInfo: ConnectedDeviceInfo | undefined;
  declare protected deviceStatus: ConnectedDeviceStatus | undefined;
  declare protected deviceLinkOnline: boolean | undefined;
  declare protected serverOnline: boolean;
  declare protected statusUpdatedAt: number;
  declare protected statusRefreshing: boolean;
  declare protected liveStatusError: string;
  #grant = '';
  #grantProvidedExternally = false;
  #ssid = '';
  #password = '';
  #encryption: 'open' | 'wpa2' | 'wpa3' = 'wpa2';
  #skipWifi = false;
  #abort: AbortController | undefined;
  #statusAbort: AbortController | undefined;
  #statusTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #removeClientListeners?: () => void;

  constructor() {
    super();
    this.compact = false;
    this.statusMessage = 'Idle';
    this.busy = false;
    this.step = 0;
    this.networkError = '';
    this.deviceId = '';
    this.deviceInfo = undefined;
    this.deviceStatus = undefined;
    this.deviceLinkOnline = undefined;
    this.serverOnline = false;
    this.statusUpdatedAt = 0;
    this.statusRefreshing = false;
    this.liveStatusError = '';
  }

  get provisioningGrant(): string { return ''; }
  set provisioningGrant(value: string) {
    const grant = value.trim();
    if (!grant) return;
    this.#grant = grant;
    this.#grantProvidedExternally = true;
    this.statusMessage = 'Ready';
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('grantaccepted', { bubbles: true, composed: true }));
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('client')) return;
    this.#removeClientListeners?.();
    if (!this.client) return;
    const client = this.client;
    const stateListener = (event: Event): void => {
      const state = String((event as CustomEvent).detail);
      this.statusMessage = state.replaceAll('_', ' ');
      if (state === 'waiting_server') { this.#stopLiveStatus(); this.liveStatusError = ''; }
    };
    const claimListener = (event: Event): void => { this.deviceId = (event as CustomEvent<{ deviceId: string }>).detail.deviceId; };
    const infoListener = (event: Event): void => { this.deviceInfo = (event as CustomEvent<ConnectedDeviceInfo>).detail; };
    const statusListener = (event: Event): void => { this.deviceStatus = (event as CustomEvent<ConnectedDeviceStatus>).detail; this.deviceLinkOnline = true; this.statusUpdatedAt = Date.now(); };
    client.addEventListener('statechange', stateListener);
    client.addEventListener('provisioningclaim', claimListener);
    client.addEventListener('deviceinfo', infoListener);
    client.addEventListener('devicestatus', statusListener);
    this.#removeClientListeners = () => { client.removeEventListener('statechange', stateListener); client.removeEventListener('provisioningclaim', claimListener); client.removeEventListener('deviceinfo', infoListener); client.removeEventListener('devicestatus', statusListener); };
  }

  protected updated(changed: PropertyValues<this>): void {
    if ((changed as Map<PropertyKey, unknown>).has('step')) this.dispatchEvent(new CustomEvent('stepchange', { detail: this.step, bubbles: true, composed: true }));
  }

  disconnectedCallback(): void {
    this.#removeClientListeners?.();
    this.#abort?.abort(new DOMException('Component disconnected', 'AbortError'));
    this.#stopLiveStatus();
    this.#grant = '';
    this.#grantProvidedExternally = false;
    this.#password = '';
    super.disconnectedCallback();
  }

  protected render() {
    const unsupported = !this.client || this.client.state === 'unsupported';
    const batteryPercent = this.deviceStatus?.batteryPercent;
    const batteryWidth = batteryPercent === null || batteryPercent === undefined ? 0 : Math.max(0, Math.min(100, batteryPercent));
    const batteryState = this.deviceStatus?.battery?.state;
    const batteryStateLabel = batteryState === 'low' ? this.#t('Low battery') : batteryState === 'charging' ? this.#t('Charging') : batteryState === 'full' ? this.#t('Fully charged') : batteryState === 'normal' ? this.#t('Normal') : '';
    const storage = this.deviceStatus?.storage;
    const storageSummary = storage ? this.#t('{free} free of {total}', { free: formatStorageCapacity(storage.freeKilobytes, this.locale), total: formatStorageCapacity(storage.totalKilobytes, this.locale) }) : this.#t('Checking');
    const storageRecordingTime = storage ? this.#t('{hours} h estimated recording time', { hours: storage.recordingHours }) : '';
    return html`<section class=${this.compact && this.step === 0 && !this.busy ? 'card compact-status-card' : 'card'}>
      ${this.compact ? nothing : html`<div class="heading"><span class="heading-icon">⌁</span><div><h2>${this.#t('Bind Voicecan device')}</h2><p>${this.#t('Assign ownership and securely bring a nearby device online. Network setup is one step when needed.')}</p></div></div>`}
      ${this.compact ? nothing : this.#steps(['Connect & bind', 'Network', 'Server', 'Online'])}
      ${this.step === 0 ? this.compact ? this.busy ? html`<div class="stage progress-visual selection-progress"><div class="progress-panel"><div class="connection-visual" aria-hidden="true"><span class="connection-orbit outer"></span><span class="connection-orbit"></span><span class="device-beacon"><span class="device-signal"><span></span><span></span><span></span></span></span></div><div class="progress-copy"><span class="monitor-kicker">${this.#t('Nearby Bluetooth')}</span><h3>${this.#t('Connecting to the selected device')}</h3><div class="progress-status" role="status" aria-live="polite"><span class="progress-status-dot" aria-hidden="true"></span><span>${this.#t(this.statusMessage)}</span></div><p class="selection-help">${this.#t('Keep the device awake and nearby while its identity and secure binding channel are verified.')}</p></div></div></div>` : html`<div class="compact-status" role="status">${this.#t(this.statusMessage)}</div>` : html`<div class="stage"><div class="stage-copy"><h3>${this.#t('Connect and bind the nearby device')}</h3><p>${this.#t('Select the device, read its identity, obtain the binding token, and complete the secure handshake. Network configuration becomes available only after binding succeeds.')}</p></div>${this.#grantProvidedExternally ? nothing : html`<label>${this.#t('Device binding grant')}<input type="password" autocomplete="off" @input=${(event: InputEvent) => { this.#grant = (event.target as HTMLInputElement).value; }}></label>`}<div class=${unsupported ? 'capability blocked' : 'capability'}><span>●</span><span>${unsupported ? this.#t('Web Bluetooth is unavailable. Use the native Android device tool.') : this.#t('Keep the expected Voicecan device nearby and verify its serial number when the browser asks you to choose.')}</span></div><form @submit=${this.#connectDevice}><div class="actions"><button type="submit" ?disabled=${unsupported || this.busy}>${this.#t('Choose device and bind')}</button></div></form></div>` : nothing}
      ${this.step === 1 ? html`<div class="stage"><div class="stage-copy"><h3>${this.#t('Check the device network')}</h3><p>${this.#t('Token binding is complete. You can now keep the current network or provide new Wi-Fi settings. The server address will not be written until the network becomes available.')}</p></div><div class="network-status"><div><span>${this.#t('Current network status')}</span><strong><span class=${this.deviceStatus?.wifiConfigured ? 'telemetry-dot online' : 'telemetry-dot'}></span>${this.deviceStatus === undefined ? this.#t('Checking') : this.deviceStatus.wifiConfigured ? this.#t('Available') : this.#t('Unavailable')}</strong></div><span class=${this.statusRefreshing ? 'live-meta refreshing' : 'live-meta'}>${this.#liveUpdateLabel()}</span></div><div class="network-note"><span>⌂</span><div><strong>${this.#t('Use the same network as the server')}</strong><span>${this.#t('The device must join the same network as the Voicecan Platform server so it can complete the first connection.')}</span></div></div><form @submit=${this.#configureNetwork} novalidate><div class="form-grid"><label class="wide" for="wifi-ssid">Wi-Fi SSID<input id="wifi-ssid" autocomplete="off" maxlength="32" .value=${this.#ssid} aria-invalid=${this.networkError ? 'true' : 'false'} aria-describedby=${this.networkError ? 'wifi-ssid-error' : nothing} @input=${this.#updateSsid}>${this.networkError ? html`<span id="wifi-ssid-error" class="field-error" role="alert">${this.networkError}</span>` : nothing}</label><label>${this.#t('Wi-Fi password')}<input type="password" autocomplete="off" maxlength="32" @input=${(event: InputEvent) => { this.#password = (event.target as HTMLInputElement).value; }}></label><label>${this.#t('Security')}<select .value=${this.#encryption} @change=${(event: Event) => { this.#encryption = (event.target as HTMLSelectElement).value as 'open' | 'wpa2' | 'wpa3'; }}><option value="wpa2">WPA2</option><option value="wpa3">WPA3</option><option value="open">${this.#t('Open')}</option></select></label></div><div class="actions"><button type="submit" ?disabled=${this.busy}>${this.#t('Configure network and continue')}</button></div></form><div class="network-skip"><div><strong>${this.#t('Keep the current device network')}</strong><span>${this.#t('The flow will keep checking until the existing network becomes available.')}</span></div><button type="button" class="secondary" ?disabled=${this.busy} @click=${this.#keepNetwork}>${this.#t('Keep network and continue')}</button></div></div>` : nothing}
      ${this.step === 2 ? html`<div class="stage provisioning-monitor"><div class="monitor-header"><div class="connection-visual" aria-hidden="true"><span class="connection-orbit outer"></span><span class="connection-orbit"></span><span class="device-beacon"><span class="device-signal"><span></span><span></span><span></span></span></span></div><div class="progress-copy"><span class="monitor-kicker">${this.#t('Connection diagnostics')}</span><h3>${this.#t('Completing device setup')}</h3><div class="progress-status" role="status" aria-live="polite"><span class="progress-status-dot" aria-hidden="true"></span><span>${this.#t(this.statusMessage)}</span></div>${this.deviceInfo ? html`<div class="provisioning-device-snapshot"><strong>${this.deviceInfo.model} · ${this.deviceInfo.serialNumber}</strong><span>•</span><code>${this.deviceInfo.firmwareVersion}</code></div>` : nothing}</div></div><div class="waiting-telemetry-grid"><div class="telemetry-card"><span class="telemetry-label">${this.#t('Nearby connection')}</span><strong class="telemetry-value"><span class=${this.deviceLinkOnline ? 'telemetry-dot online' : 'telemetry-dot'}></span>${this.deviceLinkOnline === undefined ? this.#t('Checking') : this.deviceLinkOnline ? this.#t('Connected') : this.#t('Disconnected')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Wi-Fi configuration')}</span><strong class="telemetry-value"><span class=${this.deviceStatus?.wifiConfigured ? 'telemetry-dot online' : 'telemetry-dot'}></span>${this.deviceStatus === undefined ? this.#t('Checking') : this.deviceStatus.wifiConfigured ? this.#t('Configured') : this.#t('Not configured')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Server connection')}</span><strong class="telemetry-value"><span class=${this.serverOnline ? 'telemetry-dot online' : 'telemetry-dot'}></span>${!this.deviceId ? this.#t('Checking') : this.serverOnline ? this.#t('Server online') : this.#t('Waiting for server')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Battery')}</span><strong class="telemetry-value">${batteryPercent === null || batteryPercent === undefined ? this.#t('Checking') : `${batteryPercent}%`}${batteryPercent === null || batteryPercent === undefined ? nothing : html`<span class="battery-track" aria-hidden="true"><span style=${`width:${batteryWidth}%`}></span></span>`}</strong>${batteryStateLabel ? html`<span class="telemetry-note">${batteryStateLabel}</span>` : nothing}</div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Recording')}</span><strong class="telemetry-value"><span class=${this.deviceStatus?.recording ? 'telemetry-dot recording' : 'telemetry-dot'}></span>${this.deviceStatus === undefined ? this.#t('Checking') : this.deviceStatus.recording ? this.#t('Recording now') : this.#t('Idle')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Device storage')}</span><strong class="telemetry-value"><span class=${storage ? 'telemetry-dot online' : 'telemetry-dot'}></span>${storageSummary}</strong>${storageRecordingTime ? html`<span class="telemetry-note">${storageRecordingTime}</span>` : nothing}</div></div>${this.deviceInfo ? html`<div class="device-details"><div class="device-detail"><span>${this.#t('Manufacturer')}</span><strong>${this.deviceInfo.manufacturer}</strong></div><div class="device-detail"><span>${this.#t('Hardware version')}</span><code>${this.deviceInfo.hardwareVersion ?? '—'}</code></div><div class="device-detail"><span>${this.#t('Firmware version')}</span><code>${this.deviceInfo.firmwareVersion}</code></div><div class="device-detail"><span>${this.#t('Server device ID')}</span><code title=${this.deviceId}>${this.deviceId || '—'}</code></div></div>` : nothing}<div class="monitor-footer"><span class=${this.statusRefreshing ? 'live-meta refreshing' : 'live-meta'} aria-live="polite">${this.#liveUpdateLabel()}</span><div class="actions"><button type="button" class="secondary" @click=${this.#cancel}>${this.#t('Cancel')}</button></div></div>${this.liveStatusError ? html`<div class="live-error" role="alert">${this.#t('Live status unavailable')}: ${this.#t(this.liveStatusError)}</div>` : nothing}</div>` : nothing}
      ${this.step === 3 ? html`<div class="stage device-overview"><div class="overview-heading"><span class="success-mark">✓</span><div><span class="overview-kicker">${this.#t('Live device')}</span><h3>${this.#t('Device is online')}</h3><p>${this.#t(this.statusMessage)}</p></div><span class="live-badge">${this.serverOnline ? this.#t('Server online') : this.#t('Server offline')}</span></div><div class="overview-main"><div class="identity-card"><span class="device-portrait" aria-hidden="true"></span><strong>${this.deviceInfo?.model ?? this.#t('Unknown model')}</strong><code>${this.deviceInfo?.serialNumber ?? '—'}</code></div><div class="telemetry-grid"><div class="telemetry-card"><span class="telemetry-label">${this.#t('Nearby connection')}</span><strong class="telemetry-value"><span class=${this.deviceLinkOnline ? 'telemetry-dot online' : 'telemetry-dot'}></span>${this.deviceLinkOnline === undefined ? this.#t('Checking') : this.deviceLinkOnline ? this.#t('Connected') : this.#t('Disconnected')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Battery')}</span><strong class="telemetry-value">${batteryPercent === null || batteryPercent === undefined ? '—' : `${batteryPercent}%`}${batteryPercent === null || batteryPercent === undefined ? nothing : html`<span class="battery-track" aria-hidden="true"><span style=${`width:${batteryWidth}%`}></span></span>`}</strong>${batteryStateLabel ? html`<span class="telemetry-note">${batteryStateLabel}</span>` : nothing}</div><div class="telemetry-card"><span class="telemetry-label">Wi-Fi</span><strong class="telemetry-value"><span class=${this.deviceStatus?.wifiConfigured ? 'telemetry-dot online' : 'telemetry-dot'}></span>${this.deviceStatus === undefined ? this.#t('Checking') : this.deviceStatus.wifiConfigured ? this.#t('Configured') : this.#t('Not configured')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Recording')}</span><strong class="telemetry-value"><span class=${this.deviceStatus?.recording ? 'telemetry-dot recording' : 'telemetry-dot'}></span>${this.deviceStatus === undefined ? this.#t('Checking') : this.deviceStatus.recording ? this.#t('Recording now') : this.#t('Idle')}</strong></div><div class="telemetry-card"><span class="telemetry-label">${this.#t('Device storage')}</span><strong class="telemetry-value"><span class=${storage ? 'telemetry-dot online' : 'telemetry-dot'}></span>${storageSummary}</strong>${storageRecordingTime ? html`<span class="telemetry-note">${storageRecordingTime}</span>` : nothing}</div></div></div><div class="device-details"><div class="device-detail"><span>${this.#t('Manufacturer')}</span><strong>${this.deviceInfo?.manufacturer ?? '—'}</strong></div><div class="device-detail"><span>${this.#t('Hardware version')}</span><code>${this.deviceInfo?.hardwareVersion ?? '—'}</code></div><div class="device-detail"><span>${this.#t('Firmware version')}</span><code>${this.deviceInfo?.firmwareVersion ?? '—'}</code></div><div class="device-detail"><span>${this.#t('Server device ID')}</span><code title=${this.deviceId}>${this.deviceId || '—'}</code></div></div><div class="overview-footer"><span class=${this.statusRefreshing ? 'live-meta refreshing' : 'live-meta'} aria-live="polite">${this.#liveUpdateLabel()}</span><button type="button" class="secondary" ?disabled=${this.statusRefreshing} @click=${this.#refreshStatusNow}>${this.#t('Refresh now')}</button></div>${this.liveStatusError ? html`<div class="live-error" role="alert">${this.#t('Live status unavailable')}: ${this.#t(this.liveStatusError)}</div>` : nothing}</div>` : nothing}
      ${this.step < 2 && (!this.compact || this.step === 1) ? html`<div role="status">${this.#t(this.statusMessage)}</div>` : nothing}
    </section>`;
  }

  #t(message: string, values?: Readonly<Record<string, string | number>>): string { return deviceUiText(this.locale, message, values); }

  #steps(steps: readonly string[]) { return html`<ol class="stepper" style=${`--step-count:${steps.length}`}>${steps.map((label, index) => html`<li class=${index < this.step ? 'done' : index === this.step ? 'current' : ''}><span class="marker">${index < this.step ? '✓' : index + 1}</span><span>${this.#t(label)}</span></li>`)}</ol>`; }

  #updateSsid(event: InputEvent): void {
    this.#ssid = (event.target as HTMLInputElement).value;
    if (this.networkError) {
      this.networkError = '';
      this.statusMessage = 'Ready';
    }
  }

  async #connectDevice(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await this.startProvisioning();
  }

  async startProvisioning(resolveGrant?: () => Promise<string>): Promise<void> {
    if (!this.client || this.busy) return;
    if (!this.#grant.trim() && !resolveGrant) { this.statusMessage = this.#t('Enter the one-time device binding grant.'); return; }
    this.#stopLiveStatus();
    this.deviceId = '';
    this.deviceInfo = undefined;
    this.deviceStatus = undefined;
    this.deviceLinkOnline = undefined;
    this.serverOnline = false;
    this.statusUpdatedAt = 0;
    this.liveStatusError = '';
    this.statusMessage = 'selecting';
    this.busy = true;
    this.#abort = new AbortController();
    try {
      const selection = this.client.requestDevice();
      const grantResult = resolveGrant
        ? Promise.resolve().then(resolveGrant).then((value) => ({ value }), (error: unknown) => ({ error }))
        : Promise.resolve({ value: this.#grant });
      this.selectedDevice = await selection;
      const resolved = await grantResult;
      if ('error' in resolved) throw resolved.error;
      const grant = resolved.value.trim();
      if (!grant) throw new Error('PROVISIONING_GRANT_MISSING');
      this.#grant = grant;
      this.#grantProvidedExternally = true;
      this.client.setProvisioningToken(grant);
      const connection = await this.selectedDevice.connectForProvisioning({ signal: this.#abort.signal });
      this.deviceId = connection.deviceId;
      this.deviceInfo = connection.deviceInfo;
      this.deviceStatus = connection.deviceStatus;
      this.deviceLinkOnline = true;
      this.statusUpdatedAt = Date.now();
      this.statusMessage = connection.deviceStatus.wifiConfigured ? 'Network available' : 'Network unavailable';
      this.step = 1;
      this.#startLiveStatus();
    } catch (error) {
      this.statusMessage = this.#t(messageOf(error, 'Device binding failed'));
      this.step = 0;
      this.dispatchEvent(new CustomEvent('provisionerror', { detail: error, bubbles: true, composed: true }));
    } finally {
      this.#abort = undefined;
      this.busy = false;
    }
  }

  #configureNetwork(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.#ssid.trim()) {
      this.networkError = this.#t('Enter the Wi-Fi network name.');
      this.statusMessage = this.networkError;
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>('#wifi-ssid')?.focus());
      return;
    }
    this.#skipWifi = false;
    void this.#completeProvisioning();
  }

  #keepNetwork(): void {
    this.#skipWifi = true;
    this.networkError = '';
    void this.#completeProvisioning();
  }

  async #completeProvisioning(): Promise<void> {
    if (!this.client || !this.selectedDevice || this.busy) return;
    this.#stopLiveStatus();
    this.serverOnline = false;
    this.liveStatusError = '';
    this.busy = true;
    this.step = 2;
    this.#abort = new AbortController();
    try {
      const result = await this.selectedDevice.completeProvisioning({
        signal: this.#abort.signal,
        ...(this.#skipWifi ? {} : { wifi: { ssid: this.#ssid, password: this.#password, encryption: this.#encryption } }),
      });
      this.statusMessage = this.#t('Device {id} is online.', { id: result.deviceId });
      this.deviceId = result.deviceId;
      this.deviceInfo = result.deviceInfo;
      this.serverOnline = result.serverStatus === 'online';
      this.#grant = '';
      this.#password = '';
      this.step = 3;
      this.#startLiveStatus();
      this.dispatchEvent(new CustomEvent('provisioned', { detail: result, bubbles: true, composed: true }));
    } catch (error) {
      this.#stopLiveStatus();
      this.statusMessage = this.#t(messageOf(error, 'Device binding failed'));
      this.selectedDevice = undefined;
      this.step = 0;
      this.dispatchEvent(new CustomEvent('provisionerror', { detail: error, bubbles: true, composed: true }));
    } finally {
      this.#abort = undefined;
      this.busy = false;
    }
  }

  #startLiveStatus(): void {
    this.#stopLiveStatus();
    this.#statusAbort = new AbortController();
    void this.#refreshLiveStatus();
  }

  #stopLiveStatus(): void {
    if (this.#statusTimer !== undefined) globalThis.clearTimeout(this.#statusTimer);
    this.#statusTimer = undefined;
    this.#statusAbort?.abort(new DOMException('Live status stopped', 'AbortError'));
    this.#statusAbort = undefined;
    this.statusRefreshing = false;
  }

  async #refreshLiveStatus(): Promise<void> {
    const device = this.selectedDevice;
    const controller = this.#statusAbort;
    if (!device || !controller || controller.signal.aborted || this.statusRefreshing) return;
    this.statusRefreshing = true;
    let serverStatusError = '';
    if (this.step >= 2 && this.client?.broker.observeOnline && this.deviceId) {
      try {
        this.serverOnline = await this.client.broker.observeOnline(this.deviceId, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        serverStatusError = messageOf(error, 'Server status unavailable');
      }
    }
    const refreshDeviceStatus = this.step === 1;
    if (!refreshDeviceStatus) {
      if (controller.signal.aborted) return;
      this.liveStatusError = serverStatusError;
      this.statusUpdatedAt = Date.now();
      this.statusRefreshing = false;
      if (this.#statusAbort === controller && !controller.signal.aborted && this.step === 3) this.#statusTimer = globalThis.setTimeout(() => void this.#refreshLiveStatus(), 10_000);
      return;
    }
    try {
      this.deviceStatus = await device.getStatus(controller.signal);
      if (controller.signal.aborted) return;
      this.deviceLinkOnline = true;
      this.statusUpdatedAt = Date.now();
      this.liveStatusError = serverStatusError;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.deviceLinkOnline = false;
      const deviceStatusError = messageOf(error, 'Command failed');
      this.liveStatusError = serverStatusError ? `${serverStatusError}; ${deviceStatusError}` : deviceStatusError;
    } finally {
      if (this.#statusAbort === controller) {
        this.statusRefreshing = false;
        if (!controller.signal.aborted && (this.step === 1 || this.step === 2 || this.step === 3)) this.#statusTimer = globalThis.setTimeout(() => void this.#refreshLiveStatus(), 3_000);
      }
    }
  }

  #refreshStatusNow(): void {
    if (this.#statusTimer !== undefined) globalThis.clearTimeout(this.#statusTimer);
    this.#statusTimer = undefined;
    void this.#refreshLiveStatus();
  }

  #liveUpdateLabel(): string {
    if (this.statusRefreshing) return this.#t('Updating live status');
    if (!this.statusUpdatedAt) return this.#t('Waiting for live status');
    const time = new Intl.DateTimeFormat(this.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(this.statusUpdatedAt));
    return this.#t('Status updated at {time}', { time });
  }

  #cancel(): void { this.#abort?.abort(new DOMException('Provisioning canceled', 'AbortError')); this.#stopLiveStatus(); this.selectedDevice = undefined; this.step = 0; }
}

export class VoicecanDeviceConsoleElement extends LitElement {
  static properties = { locale: { type: String, reflect: true, noAccessor: true }, device: { attribute: false }, statusMessage: { state: true }, busyAction: { state: true } };
  static styles = sharedStyles;

  #locale: DeviceUiLocale = 'en';
  get locale(): DeviceUiLocale { return this.#locale; }
  set locale(value: DeviceUiLocale | string) { const next = normalizeDeviceUiLocale(value); const previous = this.#locale; if (next !== previous) { this.#locale = next; this.requestUpdate('locale', previous); } }
  declare device?: SelectedDevice;
  declare protected statusMessage: string;
  declare protected busyAction: string;

  constructor() {
    super();
    this.statusMessage = 'Ready';
    this.busyAction = '';
  }

  protected render() {
    const actions = [['status', 'Refresh status'], ['start', 'Start recording'], ['stop', 'Stop recording'], ['files', 'List files'], ['sync', 'Request server sync']] as const;
    return html`<section class="card"><div class="heading"><span class="heading-icon">◉</span><div><h2>${this.#t('Device console')}</h2><p><slot name="summary">${this.device ? this.#t('Connected nearby device') : this.#t('No device connected')}</slot></p></div></div><div class="console-actions">${actions.map(([action, label]) => html`<button type="button" data-action=${action} @click=${() => void this.#run(action)} ?disabled=${Boolean(this.busyAction)}>${this.#t(label)}</button>`)}</div><div role="status"><pre>${this.#t(this.statusMessage)}</pre></div></section>`;
  }

  #t(message: string): string { return deviceUiText(this.locale, message); }

  async #run(action: 'status' | 'start' | 'stop' | 'files' | 'sync'): Promise<void> {
    this.busyAction = action;
    try {
      if (action === 'sync') {
        this.dispatchEvent(new CustomEvent('syncrequest', { bubbles: true, composed: true }));
        this.statusMessage = this.#t('Server sync requested.');
        return;
      }
      if (!this.device) throw new Error('No device connected');
      const result = action === 'status' ? await this.device.getStatus() : action === 'start' ? await this.device.startRecording() : action === 'stop' ? await this.device.stopRecording() : await this.device.listFiles();
      this.statusMessage = JSON.stringify(result ?? { ok: true }, null, 2);
    } catch (error) {
      this.statusMessage = this.#t(messageOf(error, 'Command failed'));
    } finally {
      this.busyAction = '';
    }
  }
}

export class VoicecanTransferOutElement extends LitElement {
  static properties = { locale: { type: String, reflect: true, noAccessor: true }, client: { attribute: false }, broker: { attribute: false }, statusMessage: { state: true }, busy: { state: true }, step: { state: true }, acknowledged: { state: true } };
  static styles = sharedStyles;

  #locale: DeviceUiLocale = 'en';
  get locale(): DeviceUiLocale { return this.#locale; }
  set locale(value: DeviceUiLocale | string) { const next = normalizeDeviceUiLocale(value); const previous = this.#locale; if (next !== previous) { this.#locale = next; this.requestUpdate('locale', previous); } }
  declare client?: VoicecanDeviceClient;
  declare broker?: TransferOutBroker;
  declare protected statusMessage: string;
  declare protected busy: boolean;
  declare protected step: number;
  declare protected acknowledged: boolean;
  #abort: AbortController | undefined;
  #grant = '';

  constructor() {
    super();
    this.statusMessage = 'Idle';
    this.busy = false;
    this.step = 0;
    this.acknowledged = false;
  }

  disconnectedCallback(): void {
    this.#abort?.abort(new DOMException('Component disconnected', 'AbortError'));
    this.#grant = '';
    super.disconnectedCallback();
  }

  protected render() {
    const unsupported = !this.client || !this.broker || this.client.state === 'unsupported';
    const steps = ['Review impact', 'Transfer grant', 'Confirm nearby', 'Released'];
    return html`<section class="card"><div class="heading"><span class="heading-icon">⇄</span><div><h2>${this.#t('Release device to another server')}</h2><p>${this.#t('A controlled transfer that preserves recordings and audit history.')}</p></div></div><ol class="stepper">${steps.map((label, index) => html`<li class=${index < this.step ? 'done' : index === this.step ? 'current' : ''}><span class="marker">${index < this.step ? '✓' : index + 1}</span><span>${this.#t(label)}</span></li>`)}</ol>
      ${this.step === 0 ? html`<div class="stage"><div class="stage-copy"><h3>${this.#t('Review the transfer impact')}</h3><p>${this.#t("This requires the source System Admin's five-minute transfer grant and a nearby device. The old credential is sealed to an ephemeral browser key. Recordings are never erased.")}</p></div><label class="ack"><input type="checkbox" .checked=${this.acknowledged} @change=${(event: Event) => { this.acknowledged = (event.target as HTMLInputElement).checked; }}><span>${this.#t('I understand that existing successful Webhook deliveries cannot be recalled.')}<small>${this.#t('The operation is recorded in the audit log.')}</small></span></label><div class="actions"><button type="button" class="danger" ?disabled=${!this.acknowledged || unsupported} @click=${() => { this.step = 1; }}>${this.#t('Continue to secure transfer')}</button></div>${unsupported ? html`<div class="capability blocked">${this.#t('Web Bluetooth is unavailable. Use the native Android device tool.')}</div>` : nothing}</div>` : nothing}
      ${this.step === 1 ? html`<div class="stage"><div class="stage-copy"><h3>${this.#t('Enter the short-lived transfer grant')}</h3><p>${this.#t('The grant stays in memory and is cleared when this flow finishes or the component closes.')}</p></div><form @submit=${this.#submit}><label>${this.#t('Transfer-out grant')}<input type="password" autocomplete="off" @input=${(event: InputEvent) => { this.#grant = (event.target as HTMLInputElement).value; }}></label><div class="actions"><button type="button" class="secondary" @click=${() => { this.step = 0; }}>${this.#t('Back')}</button><button type="submit" class="danger" ?disabled=${unsupported || this.busy}>${this.#t('Choose device and release')}</button></div></form><div role="status">${this.#t(this.statusMessage)}</div></div>` : nothing}
      ${this.step === 2 ? html`<div class="stage progress-visual"><div><span class="pulse">⇄</span><h3>${this.#t('Confirming the nearby device')}</h3><p>${this.#t(this.statusMessage)}</p><div class="actions"><button type="button" class="secondary" @click=${this.#cancel}>${this.#t('Cancel')}</button></div></div></div>` : nothing}
      ${this.step === 3 ? html`<div class="stage success-visual"><div><span class="success-mark">✓</span><h3>${this.#t('Device released safely')}</h3><p>${this.#t(this.statusMessage)}</p></div></div>` : nothing}
    </section>`;
  }

  #t(message: string, values?: Readonly<Record<string, string | number>>): string { return deviceUiText(this.locale, message, values); }

  async #submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.client || !this.broker || this.busy) return;
    const form = event.currentTarget as HTMLFormElement;
    const grant = this.#grant.trim();
    if (!grant) { this.statusMessage = this.#t('Enter the one-time transfer grant.'); return; }
    this.busy = true;
    this.step = 2;
    this.#abort = new AbortController();
    try {
      const selected = await this.client.requestDevice();
      const released = await selected.transferOut({ transferToken: grant, broker: this.broker, signal: this.#abort.signal });
      this.statusMessage = this.#t('Device {id} was released. Recordings were preserved.', { id: released.deviceId });
      this.#grant = '';
      form.reset();
      this.step = 3;
      this.dispatchEvent(new CustomEvent('released', { detail: released, bubbles: true, composed: true }));
    } catch (error) {
      this.statusMessage = this.#t(messageOf(error, 'Transfer-out failed'));
      this.step = 1;
      this.dispatchEvent(new CustomEvent('releaseerror', { detail: error, bubbles: true, composed: true }));
    } finally {
      this.#abort = undefined;
      this.busy = false;
    }
  }

  #cancel(): void { this.#abort?.abort(new DOMException('Transfer-out canceled', 'AbortError')); this.step = 1; }
}

export function registerVoicecanElements(registry: CustomElementRegistry = customElements): void {
  if (!registry.get('voicecan-provisioner')) registry.define('voicecan-provisioner', VoicecanProvisionerElement);
  if (!registry.get('voicecan-device-console')) registry.define('voicecan-device-console', VoicecanDeviceConsoleElement);
  if (!registry.get('voicecan-transfer-out')) registry.define('voicecan-transfer-out', VoicecanTransferOutElement);
}
