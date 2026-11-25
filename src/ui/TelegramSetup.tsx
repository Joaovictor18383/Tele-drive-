import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, ClipboardCopy, ClipboardPaste, Link2, ScanLine } from 'lucide-react';
import type { SessionState } from '../../shared/protocol';
import { api, RequestError, wait } from '../lib/api';
import type { T } from '../lib/i18n';
import { parseTelegramCredentials, pasteTelegramField, telegramCredentials, validTelegramHash, validTelegramId, type TelegramFields } from '../lib/telegram-credentials';
import { Dialog, Spinner } from './common';

export default function TelegramSetup({ t, revision, token, close, saved }: {
  t: T; revision?: string; token?: string; close: () => void; saved: (state: SessionState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [reveal, setReveal] = useState(false);
  const [manual, setManual] = useState(false);
  const [fields, setFields] = useState<TelegramFields>({ apiId: '', apiHash: '' });
  const [pasteNotice, setPasteNotice] = useState('');
  const idText = fields.apiId.trim();
  const hashText = fields.apiHash.trim();
  const reversed = telegramCredentials(hashText, idText);
  const credentials = telegramCredentials(idText, hashText) ?? reversed;
  const invalidId = !!idText && !validTelegramId(idText) && !reversed;
  const invalidHash = !!hashText && !validTelegramHash(hashText) && !reversed;
  const aborted = useRef<AbortController>(null);
  const origin = location.origin;
  const callback = origin + '/api/auth/callback';
  useEffect(() => () => aborted.current?.abort(), []);

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { setCopied(''); }
  };
  const importCredentials = (text: string, target?: keyof TelegramFields) => {
    const found = parseTelegramCredentials(text);
    setPasteNotice('');
    if (found) {
      setFields(found);
      setError('');
      return;
    }
    const single = pasteTelegramField(text);
    if (single) {
      const existing = fields[single.field].trim();
      const matches = single.field === 'apiId' ? validTelegramId : validTelegramHash;
      if (target && target !== single.field && matches(existing) && existing !== single.value) {
        setPasteNotice(t('O valor colado pertence ao outro campo. Cole nele para substituir o valor atual.', 'This value belongs in the other field. Paste it there to replace the current value.'));
      } else {
        setFields(previous => ({ ...previous, [single.field]: single.value }));
        if (target && target !== single.field) {
          setPasteNotice(single.field === 'apiId' ? t('O número foi colocado em API ID.', 'The number was placed in API ID.') :
            t('O valor foi colocado em API Hash. Em API ID, use o número da linha App api_id.', 'The value was placed in API Hash. For API ID, use the number on the App api_id line.'));
        }
      }
      setManual(true);
      setError('');
      return;
    }
    if (!target || text.length > 512) setError(t('Copie os valores de App api_id e App api_hash no portal do Telegram.', 'Copy the App api_id and App api_hash values from the Telegram portal.'));
    else {
      setFields(previous => ({ ...previous, [target]: text.trim().slice(0, 128) }));
      setError('');
    }
  };
  const paste = async () => {
    try { importCredentials(await navigator.clipboard.readText()); }
    catch {
      setManual(true);
      setError(t('Use Ctrl+V em cada campo para colar os valores.', 'Use Ctrl+V in each field to paste the values.'));
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !revision || !credentials || busy) return;
    const controller = new AbortController();
    aborted.current = controller;
    setBusy(true);
    setError('');
    try {
      await api('/desktop/setup', { method: 'POST', data: { token, credentials }, signal: controller.signal });
      setFields({ apiId: '', apiHash: '' });
      for (let attempt = 0; attempt < 26; attempt++) {
        await wait(380, controller.signal);
        const state = await api<SessionState>('/session', { signal: controller.signal }).catch(() => undefined);
        if (state?.configured && state.desktopSetup !== revision) { saved(state); return; }
      }
      setError(t('As credenciais foram salvas. Reabra o CloudVault se a conexão não aparecer.', 'Credentials were saved. Reopen CloudVault if the connection option does not appear.'));
    } catch (e) {
      if (controller.signal.aborted) return;
      const code = e instanceof RequestError ? e.message : '';
      const message = code === 'DESKTOP_SETUP_EXPIRED' ? t('Reabra o CloudVault pelo executável para continuar.', 'Reopen CloudVault from the executable to continue.') :
        code === 'INVALID_REQUEST' ? t('Confira o API ID e o API Hash e tente novamente.', 'Check your API ID and API Hash and try again.') :
        code === 'DESKTOP_SETUP_CONNECTED' ? t('Desconecte a conta atual para alterar a configuração.', 'Disconnect the current account to change the setup.') :
        t('Não foi possível salvar agora. Verifique se o CloudVault está aberto e tente novamente.', 'Could not save right now. Make sure CloudVault is open and try again.');
      setError(message);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  if (revision) return <Dialog className="telegram-setup guided-setup" title={t('Entrar no CloudVault', 'Sign in to CloudVault')} close={close} t={t}>
    <p>{t('Prepare o QR uma vez. Depois, o CloudVault abre direto no QR sempre que precisar conectar.', 'Set up the QR once. CloudVault then opens directly to the QR whenever you need to connect.')}</p>
    <form className="form-stack desktop-setup-form" onSubmit={submit}>
      <section className="setup-step">
        <span className="setup-step-number">1</span>
        <div>
          <h3>{t('Abra o portal oficial do Telegram', 'Open the official Telegram portal')}</h3>
          <p>{t('Entre no portal e vá em API development tools. Se aparecer um formulário de criação, use CloudVault como nome e Desktop como plataforma.', 'Sign in on the portal and go to API development tools. If a creation form appears, use CloudVault as the name and Desktop as the platform.')}</p>
          <a className="secondary" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">{t('Abrir portal do Telegram', 'Open Telegram portal')} <ArrowUpRight size={15} /></a>
        </div>
      </section>
      <section className="setup-step">
        <span className="setup-step-number">2</span>
        <div>
          <h3>{t('Traga os dois valores para o CloudVault', 'Bring both values into CloudVault')}</h3>
          <p>{t('App api_id é um número. App api_hash tem 32 caracteres. Você pode copiar as duas linhas juntas ou colar cada valor separadamente.', 'App api_id is a number. App api_hash has 32 characters. You can copy both lines together or paste each value separately.')}</p>
          <div className="setup-import" onPaste={event => { if (manual || busy || !token) return; event.preventDefault(); importCredentials(event.clipboardData.getData('text')); }}>
            <button type="button" className="secondary" disabled={busy || !token} onClick={() => void paste()}><ClipboardPaste size={16} />{t('Colar os dois valores', 'Paste both values')}</button>
            <button type="button" className="quiet" disabled={busy || !token} onClick={() => { setManual(!manual); setError(''); }}>{manual ? t('Ocultar campos', 'Hide fields') : t('Preencher separadamente', 'Fill in separately')}</button>
          </div>
          {pasteNotice && <p className="setup-paste-note" role="status">{pasteNotice}</p>}
          {credentials && !busy && <span className="setup-recognized" role="status"><Check size={16} />{reversed ?
            t('Os campos estão invertidos. O CloudVault vai salvá-los na ordem certa.', 'The fields are swapped. CloudVault will save them in the right order.') :
            t('API ID e API Hash preenchidos', 'API ID and API Hash are ready')}</span>}
          {manual && <fieldset className="setup-manual" disabled={busy || !token}>
            <div className="setup-credentials">
              <label>API ID
                <input value={fields.apiId} onChange={e => { setFields({ ...fields, apiId: e.target.value }); setPasteNotice(''); }}
                  onPaste={e => { e.preventDefault(); importCredentials(e.clipboardData.getData('text'), 'apiId'); }}
                  aria-invalid={invalidId} aria-describedby="telegram-id-help" inputMode="numeric" autoComplete="off" maxLength={128} />
                <span id="telegram-id-help" className={invalidId ? 'setup-field-error' : 'setup-field-help'}>{invalidId ?
                  t('Use o número da linha App api_id. Esse campo só aceita dígitos.', 'Use the number on the App api_id line. This field accepts digits only.') :
                  t('Número da linha App api_id.', 'Number on the App api_id line.')}</span>
              </label>
              <label>API Hash
                <input value={fields.apiHash} onChange={e => { setFields({ ...fields, apiHash: e.target.value }); setPasteNotice(''); }}
                  onPaste={e => { e.preventDefault(); importCredentials(e.clipboardData.getData('text'), 'apiHash'); }}
                  aria-invalid={invalidHash} aria-describedby="telegram-hash-help" type={reveal ? 'text' : 'password'} autoComplete="off" maxLength={128} />
                <span id="telegram-hash-help" className={invalidHash ? 'setup-field-error' : 'setup-field-help'}>{invalidHash ?
                  t('Cole os 32 caracteres completos da linha App api_hash.', 'Paste all 32 characters from the App api_hash line.') :
                  t('32 caracteres da linha App api_hash.', '32 characters from the App api_hash line.')}</span>
              </label>
            </div>
            <div className="setup-inline"><label><input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} />{t('Mostrar API Hash', 'Show API Hash')}</label></div>
          </fieldset>}
        </div>
      </section>
      {!token && <p>{t('Feche e abra o CloudVault pelo executável para habilitar esta etapa.', 'Close CloudVault and reopen it from the executable to enable this step.')}</p>}
      {error && <div className="callout error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close} disabled={busy}>{t('Fechar', 'Close')}</button>
        <button className="primary" disabled={!token || !credentials || busy}>{busy ? <Spinner /> : <ScanLine size={18} />}{busy ? t('Preparando QR…', 'Preparing QR…') : t('Salvar e mostrar QR', 'Save and show QR')}</button>
      </div>
    </form>
  </Dialog>;

  return <Dialog className="telegram-setup" title={t('Configurar Telegram', 'Set up Telegram')} close={close} t={t}>
    <p>{t('Na instalação web, adicione o API ID, o API Hash, o Client ID e o Client Secret ao arquivo .env do servidor.', 'For web installations, add the API ID, API Hash, Client ID and Client Secret to the server .env file.')}</p>
    <a className="setup-link" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org · API development tools <ArrowUpRight size={14} /></a>
    <a className="setup-link" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather · Login Widget <ArrowUpRight size={14} /></a>
    <div className="setup-addresses">
      <strong><Link2 size={16} /> {t('Cadastre estes dois endereços em Allowed URLs', 'Register both addresses in Allowed URLs')}</strong>
      {[origin, callback].map(value => <div key={value}><code>{value}</code><button type="button" className="icon-button" onClick={() => void copy(value)} aria-label={(copied === value ? t('Copiado', 'Copied') : t('Copiar', 'Copy')) + ' ' + value}>{copied === value ? <Check size={16} /> : <ClipboardCopy size={16} />}</button></div>)}
    </div>
    <div className="dialog-actions"><button type="button" className="secondary" onClick={close}>{t('Fechar', 'Close')}</button></div>
  </Dialog>;
}
