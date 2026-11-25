import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShieldCheck } from 'lucide-react';
import { LazyMotion, domAnimation } from 'motion/react';
import type { SessionState } from '../shared/protocol';
import { api, setApiAccount } from './lib/api';
import { errorText, translator } from './lib/i18n';
import { usePreferences } from './lib/preferences';
import { AccessFrame, AccountChoice, Connect, Welcome, type InstallEvent } from './ui/Access';
import { Spinner } from './ui/common';
import './style.css';
import './ui/access.css';

const Connected = lazy(() => import('./ui/Connected'));
const TelegramSetup = lazy(() => import('./ui/TelegramSetup'));

function desktopEntry() {
  const incoming = new URLSearchParams(location.hash.slice(1)).get('setup');
  const valid = (value: string | null): value is string => !!value && /^[A-Za-z0-9_-]{43}$/.test(value);
  if (valid(incoming)) {
    try { sessionStorage.setItem('cv-desktop-entry', incoming); } catch { /* The current page still has the token. */ }
    const path = location.pathname === '/api/desktop/open' ? '/' : location.pathname;
    history.replaceState(history.state, '', path + location.search);
    return { token: incoming, launched: true };
  }
  try {
    const prior = sessionStorage.getItem('cv-desktop-entry');
    return { token: valid(prior) ? prior : undefined, launched: false };
  } catch { return { token: undefined, launched: false }; }
}

function App() {
  const { prefs, setPrefs, reduced } = usePreferences();
  const t = useMemo(() => translator(prefs.language), [prefs.language]);
  const [session, setSession] = useState<SessionState>();
  const [networkError, setNetworkError] = useState<Error>();
  const [authResult, setAuthResult] = useState(() => new URLSearchParams(location.search).get('auth'));
  const [installPrompt, setInstallPrompt] = useState<InstallEvent>();
  const [{ token: setupToken, launched }] = useState(desktopEntry);
  const [choosingAccount, setChoosingAccount] = useState(launched);
  const [switchAccount, setSwitchAccount] = useState(false);
  const [setup, setSetup] = useState<boolean>();
  const [setupSaved, setSetupSaved] = useState(false);
  const [showQr, setShowQr] = useState(true);
  useLayoutEffect(() => { setApiAccount(session?.profile?.id); }, [session?.profile?.id]);
  const refresh = useCallback(async () => {
    try { setSession(await api<SessionState>('/session')); setNetworkError(undefined); }
    catch (e) { setNetworkError(e as Error); }
  }, []);
  const signedIn = useCallback((verified: SessionState) => {
    setSession(verified);
    setSwitchAccount(false);
    setNetworkError(undefined);
    setAuthResult(null);
  }, []);
  const logout = useCallback(async (revoke: boolean) => {
    await api('/auth/logout', { method: 'POST', data: { revoke } });
    setSession(old => ({ configured: old?.configured ?? true, connected: false, desktopSetup: old?.desktopSetup }));
    setChoosingAccount(!!setupToken);
    setAuthResult(null);
    history.replaceState({}, '', '/');
  }, [setupToken]);
  const expired = useCallback(() => {
    void logout(false).catch(() => {
      setSession(old => ({ configured: old?.configured ?? true, connected: false, desktopSetup: old?.desktopSetup }));
      setAuthResult('expired');
    });
  }, [logout]);
  useEffect(() => {
    if (authResult) history.replaceState({}, '', location.pathname + location.hash);
    void refresh();
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallEvent); };
    const installed = () => setInstallPrompt(undefined);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installed); };
  }, []);
  const install = installPrompt ? () => {
    void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => setInstallPrompt(undefined)).catch(() => setInstallPrompt(undefined));
  } : undefined;
  const frame = {
    t, language: prefs.language, setLanguage: (language: typeof prefs.language) => setPrefs({ ...prefs, language }), install, reduced,
    dark: prefs.theme === 'dark', toggleTheme: () => setPrefs({ ...prefs, theme: prefs.theme === 'dark' ? 'light' : 'dark' })
  };
  if (session?.desktopSetup && setupToken && choosingAccount) return <AccessFrame {...frame}>
    <AccountChoice t={t} profile={session.connected ? session.profile : undefined}
      continueAccount={() => { setChoosingAccount(false); setShowQr(true); setSwitchAccount(false); }}
      connect={() => { setChoosingAccount(false); setShowQr(true); setSwitchAccount(session.connected); }} />
  </AccessFrame>;
  if (session?.profile && session.connected && !switchAccount) return <Suspense fallback={<div className="full-loading"><ShieldCheck size={34} /><Spinner /></div>}>
    <Connected key={session.profile.id} {...{ profile: session.profile, t, prefs, setPrefs, reduced, logout, install, frame, expired }} />
  </Suspense>;
  const oauthError = authResult === 'expired' ? t('O login expirou. Inicie novamente para conectar.', 'Sign-in expired. Start again to connect.') : authResult === 'denied' ? t('O Telegram não autorizou esta conexão.', 'Telegram did not authorize this connection.') : authResult ? t('Não foi possível validar a autorização do Telegram.', 'Could not validate Telegram authorization.') : undefined;
  return <AccessFrame {...frame}>
    {session?.configured && session.desktopSetup && showQr && setupToken
      ? <Connect t={t} desktopToken={setupToken} switchAccount={switchAccount} onConnected={signedIn}
        disconnect={async () => {
          await api('/auth/qr/cancel', { method: 'POST' });
          setShowQr(false);
          setSwitchAccount(false);
          setChoosingAccount(true);
        }} /> :
      session?.profile ? <Connect t={t} profile={session.profile} onConnected={signedIn} disconnect={() => logout(true)} /> :
      networkError ? <div className="access-step"><h1>CloudVault</h1><div className="callout error" role="alert">{errorText(networkError, t)}</div><button className="primary" onClick={() => void refresh()}>{t('Tentar novamente', 'Retry')}</button></div> :
      !session ? <div className="access-loading"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /><span><Spinner />{t('Carregando CloudVault', 'Loading CloudVault')}</span></div> :
        <Welcome t={t} configured={session.configured} error={oauthError} openSetup={() => setSetup(true)} desktop={!!session.desktopSetup}
          openQr={() => setupToken ? setShowQr(true) : setSetup(true)} saved={setupSaved} />}
    {(setup ?? Boolean(setupToken && session?.desktopSetup && !session.configured)) &&
      <Suspense fallback={<div className="access-setup-loading" role="status"><Spinner />{t('Abrindo configuração…', 'Opening setup…')}</div>}>
      <TelegramSetup t={t} revision={session?.desktopSetup} token={setupToken} close={() => setSetup(false)} saved={state => {
        setSession(state);
        setSetupSaved(true);
        setShowQr(true);
        setAuthResult(null);
        setSetup(false);
      }} />
    </Suspense>}
  </AccessFrame>;
}

createRoot(document.getElementById('root')!).render(<LazyMotion features={domAnimation}><App /></LazyMotion>);
