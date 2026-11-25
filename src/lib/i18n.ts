export type Language = 'pt' | 'en';
export type T = (pt: string, en: string) => string;
export const translator = (lang: Language): T => (pt, en) => lang === 'pt' ? pt : en;
export const locale = (lang: Language) => lang === 'pt' ? 'pt-BR' : 'en-US';

export function sizeText(size: number, lang: Language) {
  if (size < 1024) return size + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const n = Math.min(Math.floor(Math.log(size) / Math.log(1024)) - 1, units.length - 1);
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 1 }).format(size / 1024 ** (n + 1)) + ' ' + units[n];
}

export const dateText = (time: number, lang: Language) =>
  new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium' }).format(time);

export function errorText(error: unknown, t: T) {
  if ((error as Error)?.name === 'AbortError') return t('Operação cancelada.', 'Action cancelled.');
  const code = typeof error === 'string' ? error : (error as Error)?.message;
  const messages: Record<string, [string, string]> = {
    SETUP_REQUIRED: ['Configure as credenciais do Telegram no servidor para habilitar a conexão.', 'Configure Telegram credentials on the server to enable sign-in.'],
    SESSION_REQUIRED: ['Sua sessão expirou. Conecte novamente.', 'Your session expired. Please reconnect.'],
    SESSION_REVOKED: ['A sessão foi revogada no Telegram. Conecte novamente.', 'The session was revoked in Telegram. Please reconnect.'],
    QR_EXPIRED: ['O QR code expirou. Gere um novo para continuar.', 'The QR code expired. Generate a new one to continue.'],
    ACCOUNT_CHANGED: ['A conta mudou em outra aba. Reabra o CloudVault para escolher a conta ativa.', 'The account changed in another tab. Reopen CloudVault to choose the active account.'],
    DESKTOP_SETUP_EXPIRED: ['Reabra o CloudVault pelo executável para iniciar a conexão.', 'Reopen CloudVault from the executable to connect.'],
    TELEGRAM_API_INVALID: ['O Telegram recusou o API ID ou o API Hash. Volte à configuração e confira os dados.', 'Telegram rejected the API ID or API Hash. Return to setup and check both values.'],
    ACCOUNT_MISMATCH: ['O QR code foi escaneado por outra conta. Use a mesma conta que autorizou seu perfil.', 'Another account scanned the code. Use the account that authorized your profile.'],
    QR_FAILED: ['O Telegram não concluiu a autorização. Tente gerar outro QR code.', 'Telegram could not finish authorization. Try generating a new QR code.'],
    QR_BUSY: ['A conexão está em andamento. Aguarde um momento.', 'The connection is in progress. Please wait a moment.'],
    TELEGRAM_2FA_INVALID: ['O Telegram rejeitou a prova de verificação. Confira a senha e tente novamente.', 'Telegram rejected the verification proof. Check your password and try again.'],
    TELEGRAM_2FA_UNSUPPORTED: ['O Telegram retornou parâmetros de verificação incompatíveis.', 'Telegram returned unsupported verification parameters.'],
    TELEGRAM_RECENT_SESSION: ['O Telegram ainda não permite revogar outras sessões neste dispositivo. Tente mais tarde.', 'Telegram has temporarily restricted this device from revoking other sessions. Try again later.'],
    TELEGRAM_WAIT: ['O Telegram aplicou um limite temporário. Aguarde antes de tentar novamente.', 'Telegram temporarily limited requests. Wait before retrying.'],
    TELEGRAM_PREMIUM_WAIT: ['O Telegram limitou a velocidade desta conta. A transferência pode continuar após a espera.', 'Telegram limited transfer speed for this account. The transfer can continue after the wait.'],
    TELEGRAM_UNAVAILABLE: ['A comunicação com o Telegram falhou. Tente novamente.', 'Communication with Telegram failed. Try again.'],
    TELEGRAM_BUSY: ['Há operações simultâneas em andamento. Tente novamente em instantes.', 'Other operations are in progress. Try again shortly.'],
    NETWORK_TIMEOUT: ['A conexão demorou demais. Tente novamente.', 'The connection timed out. Try again.'],
    NETWORK_OFFLINE: ['Sem conexão com o servidor CloudVault.', 'CloudVault server is unreachable.'],
    FILE_TOO_LARGE: ['Este arquivo supera o limite de envio da conta.', 'This file exceeds the account upload limit.'],
    FILE_UNAVAILABLE: ['O arquivo não está mais disponível nas Mensagens Salvas.', 'The file is no longer available in Saved Messages.'],
    UPLOAD_EXPIRED: ['As partes temporárias expiraram. Tente enviar novamente.', 'The temporary upload parts expired. Retry the upload.'],
    UPLOAD_BUSY: ['O limite de envios simultâneos foi atingido. Tente novamente em instantes.', 'The concurrent upload limit was reached. Try again shortly.'],
    INTEGRITY: ['Falha na verificação de integridade. O arquivo foi interrompido.', 'Integrity verification failed. The file was interrupted.'],
    SIZE_MISMATCH: ['O arquivo criptografado tem um tamanho inesperado.', 'The encrypted file size is unexpected.'],
    CHUNK_INVALID: ['O Telegram retornou um bloco inválido.', 'Telegram returned an invalid block.'],
    PASSWORD_INVALID: ['Senha mestra incorreta.', 'Incorrect master password.'],
    RECOVERY_INVALID: ['Chave de recuperação inválida.', 'Invalid recovery key.'],
    VAULT_EXISTS: ['O cofre já foi criado em outro dispositivo. Desbloqueie para continuar.', 'The vault was created on another device. Unlock it to continue.'],
    VAULT_CHANGED: ['O cofre ativo mudou. Desbloqueie novamente.', 'The active vault changed. Unlock it again.'],
    HEADER_CONFLICT: ['A proteção do cofre mudou em outro dispositivo. Sincronize antes de tentar novamente.', 'Vault credentials changed on another device. Sync before retrying.'],
    INDEX_UNAVAILABLE: ['O índice criptografado está indisponível. Tente sincronizar novamente.', 'The encrypted index is unavailable. Try syncing again.'],
    INDEX_CORRUPT: ['O índice criptografado contém dados inválidos.', 'The encrypted index contains invalid data.'],
    DUPLICATE: ['Já existe um arquivo com o mesmo conteúdo.', 'A file with the same content already exists.'],
    BROWSER_SAVE_LIMIT: ['Este navegador não conseguiu salvar um arquivo grande. Tente a versão instalada ou use um navegador com acesso a arquivos.', 'This browser could not save a large file. Try the installed app or a browser with file access.'],
    NAME_INVALID: ['Use um nome válido com até 240 caracteres, sem barras.', 'Use a valid name of up to 240 characters without slashes.'],
    NAME_EXISTS: ['Já existe um item com esse nome nesta pasta.', 'An item with that name already exists in this folder.'],
    TARGET_INVALID: ['Escolha uma pasta disponível fora da seleção.', 'Choose an available folder outside the selection.'],
    LOCKED: ['O cofre foi bloqueado.', 'The vault was locked.'],
    CANCELLED: ['Operação cancelada.', 'Action cancelled.'],
    RATE_LIMIT: ['Muitas solicitações. Aguarde e tente novamente.', 'Too many requests. Wait and try again.']
  };
  const match = code && messages[code];
  return match ? t(...match) : t('Não foi possível concluir. Tente novamente.', 'Could not complete the action. Please try again.');
}
