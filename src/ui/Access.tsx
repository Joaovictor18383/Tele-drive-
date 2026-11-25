import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, Cloud, Download, FileImage, FileText, FolderClosed, Globe2, KeyRound, LockKeyhole, Moon, ScanLine, Settings2, ShieldCheck, Sun } from 'lucide-react';
import { m } from 'motion/react';
import type { Profile, SessionState } from '../../shared/protocol';
import type { QrResponse } from '../../shared/auth';
import { api, RequestError } from '../lib/api';
import { CryptoWorker } from '../lib/worker-client';
import { errorText, type Language, type T } from '../lib/i18n';
import type { Vault } from '../lib/vault';
import { Avatar, Brand, Dialog, Spinner } from './common';
import { saveBlob } from '../lib/io';

export type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
type FrameProps = { t: T; language: Language; setLanguage: (lang: Language) => void; install?: () => void; reduced: boolean; dark?: boolean; toggleTheme?: () => void; children: ReactNode };

function Artwork({ reduced }: { reduced: boolean }) {
  return <aside className="artwork" aria-hidden>
    <div className="art-grid" /><div className="art-halo" /><div className="orbit orbit-a" /><div className="orbit orbit-b" /><div className="orbit orbit-c" />
    <span className="art-point point-a" /><span className="art-point point-b" /><span className="art-point point-c" /><span className="art-point point-d" />
    <m.div className="hero-vault" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : .58 }}>
      <div className="vault-dial"><LockKeyhole size={62} strokeWidth={1.5} /></div>
      <div className="vault-hinge top-hinge" /><div className="vault-hinge bottom-hinge" />
    </m.div>
    <div className="art-tile tile-folder"><FolderClosed size={32} strokeWidth={1.65} /></div>
    <div className="art-tile tile-image"><FileImage size={29} strokeWidth={1.65} /></div>
    <div className="art-tile tile-check"><FileText size={29} strokeWidth={1.65} /></div>
    <div className="orbit-fade" />
  </aside>;
}

export function AccessFrame({ t, language, setLanguage, install, reduced, children, dark, toggleTheme }: FrameProps) {
  return <div className="access-page" data-entry-theme={dark ? 'dark' : 'light'}><div className="access-shell">
    <header className="access-nav">
      <Brand />
      <div className="access-nav-actions">
        {install && <button className="quiet install-button" onClick={install}><Download size={17} />{t('Instalar', 'Install')}</button>}
        {toggleTheme && <button className="icon-button entry-theme" onClick={toggleTheme} aria-label={dark ? t('Usar tema claro', 'Use light theme') : t('Usar tema escuro', 'Use dark theme')}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button>}
        <label className="language-control"><Globe2 size={17} /><select aria-label={t('Idioma', 'Language')} value={language} onChange={e => setLanguage(e.currentTarget.value as Language)}>
          <option value="pt">Português</option><option value="en">English</option>
        </select></label>
      </div>
    </header>
    <main className="access-main">
      <m.section className="access-content" initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>{children}</m.section>
      <Artwork reduced={reduced} />
    </main>
    <footer className="access-footer">
      <span>© {new Date().getFullYear()} CloudVault</span>
      <a target="_blank" rel="noreferrer" href="https://core.telegram.org/api/terms">{t('Termos da API do Telegram', 'Telegram API terms')} <ArrowUpRight size={14} /></a>
    </footer>
  </div></div>;
}

export function Welcome({ t, configured, error, desktop, openSetup, openQr, saved }: {
  t: T; configured: boolean; error?: string; desktop: boolean; openSetup: () => void; openQr: () => void; saved: boolean;
}) {
  return <div className="welcome">
    <span className="eyebrow"><ShieldCheck size={16} /> {t('COFRE PESSOAL', 'PERSONAL VAULT')}</span>
    <h1>{t('Seus arquivos.', 'Your files.')}<br /><em>{t('Sob seu controle.', 'Under your control.')}</em></h1>
    <p className="access-description">{t('Organize seus arquivos em um cofre privado. O CloudVault criptografa tudo no dispositivo e sincroniza pelas suas Mensagens Salvas do Telegram.', 'Organize your files in a private vault. CloudVault encrypts everything on your device and syncs through Telegram Saved Messages.')}</p>
    <div className="entry-action">
      {configured && desktop
        ? <button className="primary connect" onClick={openQr}><ScanLine size={20} />{t('Conectar por QR', 'Connect with QR')}</button>
        : configured
        ? <a className="primary connect" href="/api/auth/start"><ScanLine size={20} />{t('Conectar com Telegram', 'Connect with Telegram')}</a>
        : <button className="primary connect" onClick={openSetup}><Settings2 size={19} />{desktop ? t('Começar', 'Get started') : t('Configurar Telegram', 'Set up Telegram')}</button>}
      {configured && desktop && <button className="quiet text-link" onClick={openSetup}>{t('Configuração', 'Setup')}</button>}
    </div>
    {saved && <div className="entry-feedback" role="status"><Check size={16} />{t('Configuração salva. Pode conectar sua conta.', 'Setup saved. You can connect your account.')}</div>}
    {error && <div className="callout error" role="alert">{error}</div>}
    {!configured && <p className="entry-note">{t('Na primeira vez, use suas credenciais de desenvolvedor do Telegram.', 'For first-time setup, use your Telegram developer credentials.')}</p>}
    <div className="welcome-features">
      <div><span className="feature-icon"><ShieldCheck size={20} /></span><div><strong>{t('Criptografia local', 'Local encryption')}</strong><small>AES-256-GCM</small></div></div>
      <div><span className="feature-icon"><Cloud size={20} /></span><div><strong>{t('Armazenamento pessoal', 'Personal storage')}</strong><small>{t('Nas suas Mensagens Salvas', 'In your Saved Messages')}</small></div></div>
    </div>
  </div>;
}

export function AccountChoice({ t, profile, continueAccount, connect }: {
  t: T; profile?: Profile; continueAccount: () => void; connect: () => void;
}) {
  return <div className="access-step account-choice">
    <h1>{t('Escolha sua conta', 'Choose your account')}</h1>
    <p className="access-description">{t('Continue no seu cofre ou conecte uma conta do Telegram pelo QR.', 'Continue to your vault or connect a Telegram account by QR.')}</p>
    <button className="account-choice-item" onClick={continueAccount}>
      {profile ? <Avatar profile={profile} /> : <span className="feature-icon"><LockKeyhole size={20} /></span>}
      <span><strong>{profile ? t('Continuar como ', 'Continue as ') + profile.name : t('Já tenho um cofre', 'I already have a vault')}</strong>
        <small>{profile ? t('Abrir o cofre com a conta já conectada.', 'Open the vault with the connected account.') :
          t('Reconecte o mesmo Telegram que você usou para criar o cofre.', 'Reconnect the Telegram account you used to create the vault.')}</small></span>
    </button>
    <button className="account-choice-item" onClick={connect}>
      <span className="feature-icon"><ScanLine size={20} /></span>
      <span><strong>{profile ? t('Conectar outra conta do Telegram', 'Connect a different Telegram account') : t('Conectar pelo Telegram', 'Connect with Telegram')}</strong>
        <small>{t('Escaneie o QR no app do Telegram.', 'Scan the QR code in the Telegram app.')}</small></span>
    </button>
  </div>;
}

export function Connect({ t, profile, desktopToken, switchAccount = false, onConnected, disconnect }: {
  t: T; profile?: Profile; desktopToken?: string; switchAccount?: boolean;
  onConnected: (state: SessionState) => void; disconnect: () => Promise<void>;
}) {
  const [state, setState] = useState<QrResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [clock, setClock] = useState(Date.now());
  const opened = useRef(false);
  const confirm = useCallback((s: QrResponse) => {
    setState(s);
    if (s.stage === 'connected') onConnected(s.session);
  }, [onConnected]);
  const start = useCallback(async () => {
    setBusy(true); setError('');
    try { confirm(await api<QrResponse>('/auth/qr', { method: 'POST', data: desktopToken ? { token: desktopToken, switchAccount } : undefined })); }
    catch (e) { setError(errorText(e, t)); }
    finally { setBusy(false); }
  }, [confirm, desktopToken, switchAccount, t]);
  useEffect(() => {
    if (desktopToken && !opened.current) { opened.current = true; void start(); }
  }, [desktopToken, start]);
  useEffect(() => {
    if (state?.stage !== 'qr') return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state?.stage]);
  useEffect(() => {
    if (state?.stage !== 'qr') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<QrResponse>('/auth/qr?wait=1', { signal: controller.signal });
        if (!active) return;
        setError('');
        confirm(next);
        if (next.stage === 'qr') timer = setTimeout(poll, 150);
      } catch (e) {
        if (!active) return;
        if (e instanceof RequestError && (e.retryAfter || !e.status || e.status >= 500)) {
          setError(errorText(e, t)); timer = setTimeout(poll, (e.retryAfter ?? 3) * 1000);
        } else { setState(undefined); setError(errorText(e, t)); }
      }
    };
    void poll();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [state?.stage, t, confirm]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state?.stage !== 'srp') return;
    const entered = password;
    setPassword(''); setBusy(true); setError('');
    const worker = new CryptoWorker();
    try {
      const proof = await worker.call('srp', state.challenge, entered);
      confirm(await api<QrResponse>('/auth/qr/proof', { method: 'POST', data: proof }));
    } catch (e) {
      setError(errorText(e, t));
      const updated = await api<QrResponse>('/auth/qr').catch(() => undefined);
      if (updated) confirm(updated);
      else if (e instanceof RequestError && e.status === 404) setState(undefined);
    } finally { worker.close(); setBusy(false); }
  };
  return <div className="access-step">
    <span className="eyebrow"><ScanLine size={16} />{t('CONECTAR ARMAZENAMENTO', 'CONNECT STORAGE')}</span>
    <h1>{desktopToken ? t('Conecte pelo QR', 'Connect with QR') : t('Vincule seu Telegram', 'Link your Telegram')}</h1>
    {profile && <div className="profile-inline"><Avatar profile={profile} /><div><strong>{profile.name}</strong>{profile.username && <small>@{profile.username}</small>}</div></div>}
    {state?.stage === 'qr' && <div className="qr-box qr-card"><img src={state.image} alt={t('QR code de autorização do Telegram', 'Telegram authorization QR code')} /><div><strong>{t('Escaneie no Telegram', 'Scan in Telegram')}</strong><p>{t('No celular, abra Configurações → Dispositivos → Conectar dispositivo.', 'On your phone, open Settings → Devices → Link Desktop Device.')}</p><p>{t('O CloudVault avança assim que o Telegram confirmar.', 'CloudVault continues as soon as Telegram confirms.')}</p><small>{t('QR renova em', 'QR renews in')} {Math.max(0, state.expires - Math.floor(clock / 1000))} s</small></div></div>}
    <p className="access-description qr-permissions">{t('A sessão do Telegram tem acesso amplo à conta. O CloudVault usa a sessão para operar seus próprios arquivos nas Mensagens Salvas.', 'The Telegram session grants broad access to your account. CloudVault uses it to manage its own files in Saved Messages.')}</p>
    {state?.stage === 'srp' && <form className="form-stack" onSubmit={submit}>
      <p>{t('O Telegram solicitou a verificação em duas etapas. A senha é processada neste dispositivo pelo protocolo oficial SRP. O CloudVault envia somente a prova criptográfica ao Telegram.', 'Telegram requested two-step verification. Your password is processed on this device using the official SRP protocol. CloudVault sends only the cryptographic proof to Telegram.')}</p>
      <label>{t('Senha de duas etapas do Telegram', 'Telegram two-step password')}<input type="password" autoComplete="off" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="primary" disabled={busy}>{busy ? <Spinner /> : <ShieldCheck size={18} />}{t('Verificar com Telegram', 'Verify with Telegram')}</button>
    </form>}
    {!state && <button className="primary" onClick={() => void start()} disabled={busy}>{busy ? <Spinner /> : <ScanLine size={19} />}{busy ? t('Gerando QR…', 'Generating QR…') : t('Gerar QR', 'Generate QR')}</button>}
    {error && <div className="callout error" role="alert">{error}</div>}
    <button className="quiet text-link" disabled={busy} onClick={() => void disconnect().catch(e => setError(errorText(e, t)))}>{desktopToken ? t('Voltar', 'Back') : t('Usar outra conta', 'Use another account')}</button>
  </div>;
}

export function RecoveryDialog({ code, close, confirm, t }: { code: string; close: () => void; confirm: () => void; t: T }) {
  return <Dialog className="recovery-dialog" title={t('Guarde sua chave de recuperação', 'Save your recovery key')} close={close} t={t}>
    <p>{t('Mantenha uma cópia em local seguro. Se perder a senha mestra e a chave de recuperação, poderá perder o acesso aos seus arquivos de forma definitiva.', 'Keep a copy in a safe place. Losing both your master password and recovery key can permanently lock you out of your files.')}</p>
    <code className="recovery-code" tabIndex={0}>{code}</code>
    <div className="dialog-actions">
      <button className="quiet" onClick={close}>{t('Agora não', 'Not now')}</button>
      <button className="secondary" onClick={() => saveBlob(new Blob([code + '\n'], { type: 'text/plain' }), 'CloudVault-recovery-key.txt')}><Download size={17} />{t('Baixar chave', 'Download key')}</button>
      <button className="primary" onClick={confirm}>{t('Guardei minha chave', 'I saved my key')}</button>
    </div>
  </Dialog>;
}

export function Unlock({ t, profile, vault, creating, unavailable, allowRecovery, disconnect, onRecovery }: {
  t: T; profile: Profile; vault: Vault; creating: boolean; unavailable: boolean; allowRecovery: boolean;
  disconnect: () => Promise<void>; onRecovery: (code: string) => void;
}) {
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (creating && secret !== confirm) { setError(t('As senhas precisam ser iguais.', 'Passwords must match.')); return; }
    setBusy(true);
    try {
      if (creating) onRecovery(await vault.create(secret));
      else await vault.unlock(secret, recover);
    } catch (e) { setError(errorText(e, t)); }
    finally { setSecret(''); setConfirm(''); setBusy(false); }
  };
  return <div className="access-step">
    <span className="eyebrow"><LockKeyhole size={16} />{t('CRIPTOGRAFIA NO DISPOSITIVO', 'ON-DEVICE ENCRYPTION')}</span>
    <h1>{creating ? t('Crie seu cofre', 'Create your vault') : t('Abra seu cofre', 'Unlock your vault')}</h1>
    <div className="profile-inline"><Avatar profile={profile} /><strong>{profile.name}</strong></div>
    {unavailable ? <><div className="callout error">{errorText('INDEX_UNAVAILABLE', t)}</div><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { await vault.sync(true); } catch (e) { setError(errorText(e, t)); } finally { setBusy(false); } }}>{t('Sincronizar', 'Sync')}</button></> :
      <form className="form-stack" onSubmit={submit}>
        <p>{creating ? t('Escolha uma senha mestra independente. Ela protege o acesso às suas chaves neste e em outros dispositivos.', 'Choose an independent master password. It protects access to your keys on this and other devices.')
          : t('Use a senha mestra do CloudVault para descriptografar seus arquivos neste dispositivo.', 'Use your CloudVault master password to decrypt your files on this device.')}</p>
        <label>{recover ? t('Chave de recuperação', 'Recovery key') : t('Senha mestra', 'Master password')}<input value={secret} onChange={e => setSecret(e.target.value)} type="password" required minLength={creating ? 12 : undefined} maxLength={1024} autoComplete={creating ? 'new-password' : 'off'} placeholder={creating ? t('Pelo menos 12 caracteres', 'At least 12 characters') : undefined} /></label>
        {creating && <label>{t('Confirme a senha mestra', 'Confirm master password')}<input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" required minLength={12} maxLength={1024} autoComplete="new-password" /></label>}
        <button className="primary" disabled={busy}>{busy ? <Spinner /> : <KeyRound size={18} />}{creating ? t('Criar cofre', 'Create vault') : t('Desbloquear', 'Unlock')}</button>
      </form>}
    {error && <div className="callout error" role="alert">{error}</div>}
    <div className="step-links">
      {allowRecovery && <button className="quiet text-link" onClick={() => { setSecret(''); setRecover(!recover); setError(''); }}>{recover ? t('Usar senha mestra', 'Use master password') : t('Usar chave de recuperação', 'Use recovery key')}</button>}
      <button className="quiet text-link" onClick={() => void disconnect().catch(e => setError(errorText(e, t)))}>{t('Desconectar', 'Disconnect')}</button>
    </div>
  </div>;
}
