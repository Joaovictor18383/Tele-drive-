import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, Shield, LockKeyhole, LoaderCircle } from 'lucide-react';
import type { Profile } from '../../shared/protocol';
import type { T } from '../lib/i18n';

export function Brand() {
  return <div className="brand"><span className="brand-mark"><Shield size={22} /><LockKeyhole size={9} className="brand-lock" /></span><span>Cloud<span className="brand-vault">Vault</span></span></div>;
}
export const Spinner = () => <LoaderCircle className="spin" size={18} aria-hidden />;
export const Avatar = ({ profile }: { profile: Profile }) =>
  <span className="avatar" aria-label={profile.name}>
    {Array.from(profile.name.trim())[0]?.toUpperCase() || 'T'}
    {profile.picture && <img src={profile.picture} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}
  </span>;

export function Dialog({ title, close, children, t, className = '' }: { title: string; close: () => void; children: ReactNode; t: T; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog className={'dialog ' + className} ref={ref} aria-labelledby={label} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="dialog-body">
      <header><h2 id={label}>{title}</h2><button className="icon-button" onClick={close} aria-label={t('Fechar', 'Close')}><X size={20} /></button></header>
      {children}
    </div>
  </dialog>;
}

export function Empty({ icon, title, detail, action }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h2>{title}</h2>{detail && <p>{detail}</p>}{action}</div>;
}
