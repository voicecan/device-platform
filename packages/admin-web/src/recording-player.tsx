import { useEffect, useRef, useState } from 'react';
import { Icon, type Translate } from './ui.js';
import { Lc3RecordingPlayer, type Lc3PlayerSnapshot } from './lc3-player.js';

const EMPTY: Lc3PlayerSnapshot = { playing: false, loading: false, position: 0, duration: 0, error: '' };

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

let activePlayer: Lc3RecordingPlayer | undefined;

export function InlineLc3Player({ fileId, t }: { fileId: string; t: Translate }) {
  const playerRef = useRef<Lc3RecordingPlayer | undefined>(undefined);
  const [state, setState] = useState<Lc3PlayerSnapshot>(EMPTY);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    const player = new Lc3RecordingPlayer(fileId);
    playerRef.current = player;
    const unsubscribe = player.subscribe(setState);
    void player.prepare();
    return () => {
      unsubscribe();
      playerRef.current = undefined;
      void player.close();
    };
  }, [fileId]);

  const toggle = (): void => {
    const player = playerRef.current;
    if (!player) return;
    if (state.playing) player.pause();
    else {
      if (activePlayer && activePlayer !== player) activePlayer.pause();
      activePlayer = player;
      void player.play();
    }
  };

  const seek = (value: string): void => {
    playerRef.current?.seek(Number(value));
  };

  return <div className="recording-player-inline" aria-label={t('Play recording')} aria-busy={state.loading}>
    <button type="button" className="recording-player-toggle" aria-label={t(state.playing ? 'Pause' : 'Play')} disabled={state.loading} onClick={toggle}>
      <Icon name={state.playing ? 'pause' : 'play'} size={15}/>
    </button>
    <input
      className="recording-player-seek"
      type="range"
      min="0"
      max={Math.max(0, state.duration)}
      step="0.1"
      value={Math.min(scrub ?? state.position, state.duration || 0)}
      aria-label={t('Seek audio')}
      disabled={state.loading || state.duration <= 0}
      onChange={(event) => setScrub(Number(event.target.value))}
      onPointerUp={(event) => { const value = Number(event.currentTarget.value); setScrub(null); seek(String(value)); }}
      onPointerCancel={() => setScrub(null)}
      onKeyUp={(event) => { const value = Number(event.currentTarget.value); setScrub(null); seek(String(value)); }}
      onBlur={() => setScrub(null)}
    />
    <span className="recording-player-time">{formatTime(scrub ?? state.position)} / {formatTime(state.duration)}</span>
    {state.loading ? <small className="recording-player-status" role="status">{t('Loading audio…')}</small> : null}
    {state.error ? <small className="recording-player-status recording-player-error" role="alert">{t('Audio playback failed.')} {state.error}</small> : null}
  </div>;
}
