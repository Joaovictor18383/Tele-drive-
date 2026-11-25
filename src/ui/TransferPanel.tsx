import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronUp, CircleAlert, ListChecks, Pause, Play, RotateCw, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { errorText, sizeText, type Language, type T } from '../lib/i18n';
import type { Stage, Transfers } from '../lib/transfers';
import { Empty } from './common';

const statuses: Record<Stage, [string, string]> = {
  queued: ['Na fila', 'Queued'], hashing: ['Verificando conteúdo', 'Checking contents'], encrypting: ['Criptografando', 'Encrypting'],
  uploading: ['Enviando criptografado', 'Uploading encrypted data'], downloading: ['Baixando criptografado', 'Downloading encrypted data'],
  decrypting: ['Descriptografando', 'Decrypting'], saving: ['Salvando no índice', 'Saving to index'], paused: ['Pausado', 'Paused'],
  waiting: ['Aguardando nova tentativa', 'Waiting to retry'], done: ['Concluído', 'Complete'], error: ['Falhou', 'Failed'],
  cancelling: ['Cancelando', 'Cancelling'], cancelled: ['Cancelado', 'Cancelled'], duplicate: ['Arquivo duplicado', 'Duplicate file']
};
const active = new Set<Stage>(['queued', 'hashing', 'encrypting', 'uploading', 'downloading', 'decrypting', 'paused', 'waiting']);
const retry = new Set<Stage>(['error', 'cancelled', 'duplicate']);

export function TransferPanel({ transfers, t, lang, floating, collapsed, toggle, close }: {
  transfers: Transfers; t: T; lang: Language; floating?: boolean; collapsed?: boolean; toggle?: () => void; close?: () => void;
}) {
  const rows = useSyncExternalStore(transfers.subscribe, transfers.getSnapshot);
  if (!rows.length) return floating ? null : <Empty icon={<ListChecks size={30} />} title={t('Nenhuma transferência', 'No transfers')} detail={t('Seus envios e downloads aparecem aqui.', 'Your uploads and downloads appear here.')} />;
  const pending = rows.filter(r => active.has(r.stage) || r.stage === 'saving' || r.stage === 'cancelling').length;
  return <section className={floating ? 'transfer-box floating' : 'transfer-box'}>
    <header>
      <div><h2>{floating ? t('Transferências', 'Transfers') : t('Atividade de transferências', 'Transfer activity')}</h2><small>{pending ? t(`${pending} em andamento`, `${pending} in progress`) : t('Fila atualizada', 'Queue up to date')}</small></div>
      <div className="inline-actions">
        {!floating && <button className="quiet" onClick={() => transfers.clearFinished()}>{t('Limpar concluídas', 'Clear completed')}</button>}
        {toggle && <button className="icon-button" onClick={toggle} aria-label={collapsed ? t('Expandir', 'Expand') : t('Recolher', 'Collapse')}>{collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
        {close && <button className="icon-button" onClick={close} aria-label={t('Fechar painel', 'Close panel')}><X size={18} /></button>}
      </div>
    </header>
    {!collapsed && <div className="transfer-scroll">{[...rows].reverse().map(row => {
      const percent = row.stage === 'done' ? 100 : row.size ? Math.min(99, Math.floor(row.done / row.size * 100)) : 0;
      return <article className="transfer-row" key={row.id}>
        <span className={'transfer-icon ' + (row.stage === 'error' || row.stage === 'duplicate' ? 'warn' : '')}>
          {row.stage === 'done' ? <Check size={18} /> : row.stage === 'error' || row.stage === 'duplicate' ? <CircleAlert size={18} /> : row.direction === 'upload' ? <ArrowUpFromLine size={18} /> : <ArrowDownToLine size={18} />}
        </span>
        <div className="transfer-info">
          <strong title={row.name}>{row.name}</strong>
          <small>{t(...statuses[row.stage])} · {sizeText(row.size, lang)}{row.speed ? ' · ' + sizeText(row.speed, lang) + '/s' : ''}{row.eta !== undefined && row.eta > 0 ? ' · ' + (row.eta >= 60 ? Math.ceil(row.eta / 60) + ' min' : row.eta + ' s') : ''}</small>
          {row.error && <small className={row.stage === 'waiting' ? '' : 'negative'}>{errorText(row.error, t)}{row.retryAt && row.stage === 'waiting' ? ' · ' + new Date(row.retryAt).toLocaleTimeString() : ''}</small>}
          <div className="transfer-progress"><progress max={100} value={percent} aria-label={t('Progresso', 'Progress')} /><small>{percent}%</small></div>
        </div>
        <div className="inline-actions">
          {active.has(row.stage) && <><button className="icon-button" title={row.stage === 'paused' ? t('Continuar', 'Resume') : t('Pausar', 'Pause')} onClick={() => transfers.pause(row.id)}>{row.stage === 'paused' ? <Play size={16} /> : <Pause size={16} />}</button>
            <button className="icon-button" title={t('Cancelar', 'Cancel')} onClick={() => transfers.cancel(row.id)}><X size={16} /></button></>}
          {retry.has(row.stage) && <button className="icon-button" title={row.stage === 'duplicate' ? t('Enviar mesmo assim', 'Upload anyway') : t('Tentar novamente', 'Try again')} onClick={() => void transfers.retry(row.id)}><RotateCw size={16} /></button>}
        </div>
      </article>;
    })}</div>}
  </section>;
}
