import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Download, Globe2, KeyRound, LockKeyhole, LogOut, Monitor, Palette, ShieldCheck, Smartphone, Trash2, Zap } from 'lucide-react';
import type { Profile } from '../../shared/protocol';
import { api } from '../lib/api';
import { dateText, errorText, type T } from '../lib/i18n';
import { saveBlob } from '../lib/io';
import type { Preferences } from '../lib/preferences';
import type { Vault } from '../lib/vault';
import { Avatar, Dialog, Spinner } from './common';

type AuthSession = { id: string; current: boolean; location: string; active: number };
type Modal = 'password' | 'recovery' | 'logout' | 'cache' | 'revoke';
function Row({ icon, title, detail, children }: { icon: ReactNode; title: string; detail?: string; children: ReactNode }) {
  return <div className="setting-row"><span className="setting-icon">{icon}</span><div className="setting-info"><strong>{title}</strong>{detail && <small>{detail}</small>}</div>{children}</div>;
}

export default function Settings({ vault, profile, prefs, setPrefs, logout, onRecovery, notify, t, install }: {
  vault: Vault; profile: Profile; prefs: Preferences; setPrefs: (prefs: Preferences) => void; logout: (revoke: boolean) => Promise<void>;
  onRecovery: (code: string) => void; notify: (text: string) => void; t: T; install?: () => void;
}) {
  const [sessions, setSessions] = useState<AuthSession[]>();
  const [sessionError, setSessionError] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modal, setModal] = useState<Modal>();
  const [revokeId, setRevokeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const recovering = vault.state.recoveryRequired;
  const show = (value: Modal) => { setError(''); setModal(value); };
  const close = () => { if (!busy) setModal(undefined); };
  const load = async () => {
    setSessions(undefined);
    setSessionError('');
    try { setSessions(await api<AuthSession[]>('/telegram/sessions', { signal: vault.signal })); }
    catch (e) { if (!vault.signal.aborted) setSessionError(errorText(e, t)); }
  };
  useEffect(() => { if (recovering) show('password'); }, [recovering]);

  const doAction = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); setModal(undefined); }
    catch (e) { setError(errorText(e, t)); }
    finally { setBusy(false); }
  };
  const exportIndex = () => {
    saveBlob(new Blob([JSON.stringify(vault.encryptedExport())], { type: 'application/octet-stream' }), 'CloudVault-index.enc');
    notify(t('Índice criptografado exportado.', 'Encrypted index exported.'));
  };
  const credentials = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const current = String(fields.get('current') ?? '');
    const password = String(fields.get('next') ?? '');
    if (modal === 'password' && password !== fields.get('confirm')) {
      setError(t('As senhas precisam ser iguais.', 'Passwords must match.'));
      return;
    }
    e.currentTarget.reset();
    void doAction(async () => {
      if (modal === 'password') { await vault.changePassword(current, password); notify(t('Senha mestra atualizada.', 'Master password updated.')); }
      else onRecovery(await vault.rotateRecovery(current));
    });
  };
  const title = modal === 'password' ? t('Alterar senha mestra', 'Change master password') :
    modal === 'recovery' ? t('Gerar chave de recuperação', 'Generate recovery key') :
    modal === 'cache' ? t('Limpar cache local', 'Clear local cache') :
    modal === 'revoke' ? t('Revogar sessão do CloudVault', 'Revoke CloudVault session') : t('Desconectar Telegram', 'Disconnect Telegram');
  return <div className="settings">
    <section><h2>{t('Conta', 'Account')}</h2>
      <div className="settings-card">
        <div className="settings-profile"><Avatar profile={profile} /><div><strong>{profile.name}</strong><small>{profile.username ? '@' + profile.username + ' · ' : ''}{t('Telegram conectado', 'Telegram connected')}</small></div><span className="status-badge"><ShieldCheck size={15} />{t('Verificada', 'Verified')}</span></div>
        <Row icon={<Smartphone size={20} />} title={t('Sessões CloudVault', 'CloudVault sessions')} detail={t('Veja e revogue os dispositivos autorizados.', 'View and revoke authorized devices.')}>
          <button className="secondary" onClick={() => { setSessionsOpen(!sessionsOpen); if (!sessionsOpen) void load(); }}>{sessionsOpen ? t('Ocultar', 'Hide') : t('Gerenciar', 'Manage')}</button>
        </Row>
        {sessionsOpen && <div className="session-list">
          {sessionError ? <div className="callout error">{sessionError} <button className="quiet" onClick={() => void load()}>{t('Tentar novamente', 'Retry')}</button></div> :
            !sessions ? <Spinner /> : sessions.map(session => <div className="session-item" key={session.id}><Monitor size={19} /><div><strong>{session.current ? t('Este dispositivo', 'This device') : t('Outro dispositivo', 'Another device')}</strong><small>{session.location ? session.location + ' · ' : ''}{dateText(session.active, prefs.language)}</small></div>
              <button className="secondary" onClick={() => { setRevokeId(session.id); show(session.current ? 'logout' : 'revoke'); }}>{t('Revogar', 'Revoke')}</button></div>)}
        </div>}
      </div>
    </section>
    <section><h2>{t('Preferências', 'Preferences')}</h2><div className="settings-card">
      <Row icon={<Palette size={20} />} title={t('Tema', 'Theme')}><select aria-label={t('Tema', 'Theme')} value={prefs.theme} onChange={e => setPrefs({ ...prefs, theme: e.target.value as Preferences['theme'] })}><option value="auto">{t('Automático', 'Automatic')}</option><option value="light">{t('Claro', 'Light')}</option><option value="dark">{t('Escuro', 'Dark')}</option></select></Row>
      <Row icon={<Globe2 size={20} />} title={t('Idioma', 'Language')}><select aria-label={t('Idioma', 'Language')} value={prefs.language} onChange={e => setPrefs({ ...prefs, language: e.target.value as Preferences['language'] })}><option value="pt">Português</option><option value="en">English</option></select></Row>
      <Row icon={<Zap size={20} />} title={t('Modo de desempenho', 'Performance mode')} detail={t('Reduz efeitos visuais em dispositivos com poucos recursos.', 'Reduces visual effects on low-resource devices.')}>
        <select aria-label={t('Modo de desempenho', 'Performance mode')} value={prefs.economy} onChange={e => setPrefs({ ...prefs, economy: e.target.value as Preferences['economy'] })}><option value="auto">{t('Automático', 'Automatic')}</option><option value="on">{t('Ativado', 'On')}</option><option value="off">{t('Desativado', 'Off')}</option></select></Row>
      <Row icon={<Zap size={20} />} title={t('Animações', 'Animations')}><button type="button" role="switch" aria-checked={prefs.motion} aria-label={t('Animações', 'Animations')} className="switch" onClick={() => setPrefs({ ...prefs, motion: !prefs.motion })} /></Row>
      {install && <Row icon={<Download size={20} />} title={t('Instalação', 'Installation')}><button className="secondary" onClick={install}>{t('Instalar CloudVault', 'Install CloudVault')}</button></Row>}
    </div></section>
    <section><h2>{t('Segurança e dados', 'Security and data')}</h2><div className="settings-card">
      <Row icon={<LockKeyhole size={20} />} title={t('Bloqueio automático', 'Automatic lock')} detail={t('Tempo de inatividade antes de bloquear o cofre.', 'Inactivity before the vault locks.')}><select aria-label={t('Bloqueio automático', 'Automatic lock')} value={prefs.lock} onChange={e => setPrefs({ ...prefs, lock: Number(e.target.value) })}>{[1, 5, 10, 30].map(m => <option key={m} value={m}>{m} min</option>)}</select></Row>
      <Row icon={<KeyRound size={20} />} title={t('Senha mestra', 'Master password')}><button className="secondary" onClick={() => show('password')}>{t('Alterar', 'Change')}</button></Row>
      <Row icon={<ShieldCheck size={20} />} title={t('Chave de recuperação', 'Recovery key')} detail={t('Gere e baixe uma nova chave com sua senha mestra.', 'Generate and download a new key using your master password.')}><button className="secondary" disabled={recovering} onClick={() => show('recovery')}>{t('Gerar e exportar', 'Generate and export')}</button></Row>
      <Row icon={<Download size={20} />} title={t('Índice criptografado', 'Encrypted index')} detail={t('Exporta o histórico criptografado de pastas e arquivos.', 'Exports the encrypted history of folders and files.')}><button className="secondary" onClick={exportIndex}>{t('Exportar', 'Export')}</button></Row>
      <Row icon={<Trash2 size={20} />} title={t('Cache protegido', 'Protected cache')}><button className="secondary" onClick={() => show('cache')}>{t('Limpar', 'Clear')}</button></Row>
      <Row icon={<LogOut size={20} />} title={t('Conexão com Telegram', 'Telegram connection')}><button className="danger-outline" onClick={() => show('logout')}>{t('Desconectar', 'Disconnect')}</button></Row>
    </div></section>
    {modal && <Dialog title={title} close={close} t={t}>
      {(modal === 'password' || modal === 'recovery') && <form className="form-stack" onSubmit={credentials}>
        {modal === 'recovery' && <p>{t('Guarde a nova chave em local seguro. O fluxo de recuperação usará a versão mais recente da chave.', 'Store the new key safely. The recovery flow will use the latest version of the key.')}</p>}
        {recovering && <p>{t('Você usou uma chave de recuperação. Defina uma nova senha mestra para concluir a recuperação.', 'You used a recovery key. Set a new master password to complete recovery.')}</p>}
        {!recovering && <label>{t('Senha mestra atual', 'Current master password')}<input type="password" name="current" autoComplete="off" required /></label>}
        {modal === 'password' && <>
          <label>{t('Nova senha mestra', 'New master password')}<input type="password" name="next" minLength={12} maxLength={1024} required autoComplete="new-password" /></label>
          <label>{t('Confirme a nova senha', 'Confirm new password')}<input type="password" name="confirm" minLength={12} maxLength={1024} required autoComplete="new-password" /></label>
        </>}
        <div className="dialog-actions"><button className="primary" disabled={busy}>{busy && <Spinner />}{modal === 'recovery' ? t('Gerar chave', 'Generate key') : t('Salvar senha', 'Save password')}</button></div>
      </form>}
      {(modal === 'cache' || modal === 'revoke' || modal === 'logout') && <>
        <p>{modal === 'cache' ? t('O índice local será removido deste navegador. A próxima conexão poderá reconstruí-lo a partir das Mensagens Salvas.', 'The local index will be removed from this browser. The next connection can rebuild it from Saved Messages.') :
          modal === 'revoke' ? t('O outro dispositivo perderá a autorização do Telegram.', 'The other device will lose its Telegram authorization.') :
          t('Encerre a conexão neste navegador. Para invalidar também a autorização no Telegram, escolha revogar a sessão.', 'Close the connection in this browser. To invalidate the authorization in Telegram too, choose to revoke the session.')}</p>
        <div className="dialog-actions">
          <button className="secondary" disabled={busy} onClick={modal === 'logout' ? () => void doAction(() => logout(false)) : close}>{modal === 'logout' ? t('Apenas desconectar', 'Disconnect only') : t('Cancelar', 'Cancel')}</button>
          <button className={modal === 'cache' ? 'primary' : 'danger'} disabled={busy} onClick={() => void doAction(async () => {
            if (modal === 'logout') await logout(true);
            if (modal === 'revoke') { await api('/telegram/sessions/' + revokeId, { method: 'DELETE' }); await load(); }
            if (modal === 'cache') { await vault.clearCache(); notify(t('Cache local limpo.', 'Local cache cleared.')); }
          })}>{busy && <Spinner />}{modal === 'cache' ? t('Limpar cache', 'Clear cache') : t('Revogar sessão', 'Revoke session')}</button>
        </div>
      </>}
      {error && <div className="callout error" role="alert">{error}</div>}
    </Dialog>}
  </div>;
}
