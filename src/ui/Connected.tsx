import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Profile } from '../../shared/protocol';
import { RequestError } from '../lib/api';
import type { translator } from '../lib/i18n';
import type { usePreferences } from '../lib/preferences';
import { Vault } from '../lib/vault';
import { AccessFrame, RecoveryDialog, Unlock } from './Access';
import { Spinner } from './common';

const Drive = lazy(() => import('./Drive'));

export default function Connected({ profile, t, prefs, setPrefs, reduced, logout, install, frame, expired }: {
  profile: Profile; t: ReturnType<typeof translator>; prefs: ReturnType<typeof usePreferences>['prefs'];
  setPrefs: ReturnType<typeof usePreferences>['setPrefs']; reduced: boolean;
  logout: (revoke: boolean) => Promise<void>; install?: () => void;
  frame: Omit<React.ComponentProps<typeof AccessFrame>, 'children'>; expired: () => void;
}) {
  const [vault] = useState(() => new Vault(profile.id));
  const { unlocked, header, offline, busy } = useSyncExternalStore(vault.subscribe, vault.getSnapshot);
  const [recovery, setRecovery] = useState<{ code: string; visible: boolean }>();
  const showRecovery = (code: string) => setRecovery({ code, visible: true });
  const reopenRecovery = recovery && !recovery.visible ? () => setRecovery({ ...recovery, visible: true }) : undefined;
  const lock = useCallback(() => { setRecovery(undefined); vault.lock(); }, [vault]);
  useEffect(() => {
    void vault.init().catch(e => { if (e instanceof RequestError && e.status === 401) expired(); });
    return () => vault.close();
  }, [vault, expired]);
  useEffect(() => {
    if (!unlocked) return;
    const timeout = prefs.lock * 60_000;
    let activity = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = timeout - (Date.now() - activity);
      clearTimeout(timer);
      if (remaining <= 0) lock();
      else timer = setTimeout(check, remaining);
    };
    const move = () => {
      if (Date.now() - activity >= timeout) { check(); return; }
      activity = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, move, { passive: true });
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    timer = setTimeout(check, timeout);
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, move);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
    };
  }, [unlocked, prefs.lock, lock]);
  return <>
    {unlocked ? <Suspense fallback={<div className="full-loading"><ShieldCheck size={34} /><Spinner /></div>}>
      <Drive {...{ vault, profile, prefs, setPrefs, t, reduced, logout, lock, install, reopenRecovery }} onRecovery={showRecovery} onExpired={expired} />
    </Suspense> : <AccessFrame {...frame}>
      {busy ? <div className="access-loading"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /><span><Spinner />{t('Sincronizando cofre', 'Syncing your vault')}</span></div> :
        <Unlock t={t} profile={profile} vault={vault} creating={!header && !offline} unavailable={!header && offline} allowRecovery={!!header}
          disconnect={() => logout(true)} onRecovery={showRecovery} />}
    </AccessFrame>}
    {unlocked && recovery?.visible && <RecoveryDialog code={recovery.code}
      close={() => setRecovery({ ...recovery, visible: false })} confirm={() => setRecovery(undefined)} t={t} />}
  </>;
}
