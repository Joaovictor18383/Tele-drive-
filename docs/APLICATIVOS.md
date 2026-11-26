# Aplicativos TeleDrive

Baixe o instalador Windows e o APK Android na [página pública de versões](https://github.com/Joaovictor18383/Tele-drive-/releases).

## Windows

Abra `Tele-Drive.exe` para instalar no perfil atual do Windows. O instalador cria a entrada do menu Iniciar e oferece um atalho na área de trabalho. O PC precisa do Microsoft Edge WebView2 Runtime. A edição instalada abre o cofre web em janela própria. A edição antiga de `CloudVault.exe` continua sendo uma ferramenta separada para o cofre de Mensagens Salvas.

O aplicativo verifica a versão no GitHub ao abrir. Para uma versão mais nova, valida a assinatura RSA e o SHA-256 do instalador e aplica a atualização ao sair, sem fechar a janela durante uma transferência. A interface web recebe suas próprias atualizações da Vercel e do service worker. O instalador usa um manifesto de atualização assinado pelo projeto e ainda está sem certificado Authenticode.

Para gerar uma atualização, altere a versão do pacote, execute `npm run build:setup` em Windows x64 com o Inno Setup 6 e rode `./windows/sign-update.ps1` com a chave local original. Publique a tag `vX.Y.Z` com `Tele-Drive.exe`, o mesmo instalador como `CloudVaultSetup.exe` para o atualizador e o manifesto `windows-update.txt`.

## Android

`Tele-Drive.apk` requer Android 7 ou superior. A tela inicial oferece **Abrir o cofre** na janela interna com Android System WebView e **Usar sessão antiga** para abrir a edição anterior com um navegador compatível. A janela interna pode pedir um novo login porque usa um armazenamento próprio. Para instalar uma versão nova do APK, use um APK assinado com o mesmo certificado e um `versionCode` maior. O Android exige confirmação para atualizações de APK instaladas fora da loja.

Entre com nome e senha do Tele Drive. Na primeira conexão do aparelho, escolha **Neste celular**, informe o API ID, o API Hash e o telefone do Telegram com DDI. Solicite o código e volte ao Tele Drive para confirmá-lo. O Telegram pode exigir a senha de duas etapas. Os dados de autorização seguem diretamente deste aparelho ao Telegram. A sessão é cifrada e fica salva no aparelho. O QR segue disponível para autorizar com uma segunda tela.

O workflow **Compilar Android** gera o APK sem assinatura no GitHub privado. Baixe o artefato e use `android/sign-apk.ps1` com o Java, Android SDK Build Tools e a chave local original. O script valida a assinatura e a impressão digital publicada no domínio. Mantenha os arquivos de assinatura e suas senhas com backup protegido fora do Git.

A partir da versão 1.1.13, o Android verifica as atualizações ao abrir a tela inicial, valida o manifesto assinado, o SHA-256 e o certificado do APK, e baixa a versão disponível. A instalação depende da confirmação do Android e, na primeira vez, da autorização para instalar atualizações desta origem. O app inicia em tema escuro.

Para publicar uma atualização Android, execute também `android/sign-update.ps1` depois de assinar o APK. Publique `android-update.txt` junto ao APK na mesma versão. A chave privada do manifesto fica protegida localmente e a chave pública está incorporada ao app.

## Login salvo

**Lembrar de mim** vem marcado. O cookie de autenticação é HttpOnly e permanece válido por até 30 dias, com renovação durante o uso. Autorizações MTProto continuam cifradas no dispositivo. Sair, revogar um dispositivo, limpar os dados do aplicativo ou perder a autorização do Telegram pode exigir novo login.

Desde a versão 1.1.14, marque **Desbloquear automaticamente neste aparelho** ao abrir o cofre para autorizar a reabertura sem senha mestra. Essa opção é voluntária: cifra a chave do cofre com uma chave AES não exportável no IndexedDB, vinculada ao cofre e ao cabeçalho criptográfico atual. A senha mestra não é salva. Somente use em aparelho pessoal com bloqueio de tela; quem conseguir usar este perfil do dispositivo poderá abrir o cofre. Essa proteção local não resiste a código malicioso executado na mesma origem ou a um aparelho comprometido.

Bloquear o cofre manualmente, sair da conta, mudar a senha mestra ou trocar a chave de recuperação invalida a autorização local. O bloqueio por inatividade em primeiro plano também a remove. Suspender o aplicativo em segundo plano limpa as chaves em memória após o prazo de inatividade, preservando a autorização explícita para retomar. Sem essa opção, a senha mestra continua necessária. A autorização é própria de cada aparelho e não é enviada ao servidor.

## Notas e miniaturas

No Meu Drive ou Início, clique com o botão direito na área vazia para abrir **Nova pasta**, **Upload de arquivo**, **Upload de pasta** e **Bloco de notas**. No celular, as mesmas ações ficam em **+ Novo**. O editor salva arquivos de texto UTF-8 de até 2 MiB, permite editar textos existentes e aceita Ctrl/Cmd+S. As alterações são enviadas por AES-GCM em blocos, com chave e identidade de conteúdo novas. O índice substitui o conteúdo somente depois do envio; falhas de leitura impedem salvar um texto vazio sobre o original.

Imagens e vídeos compatíveis recebem uma prévia WebP local, pequena e cifrada dentro do índice. Ela aparece durante a transferência e nas visualizações de lista e grade após salvar, inclusive em outros aparelhos com o cofre desbloqueado. Arquivos antigos sem prévia mantêm a geração sob demanda para imagens pequenas. Formatos sem decodificador compatível, imagens acima de 24 MiB e arquivos que excedam o tempo de geração usam o ícone do formato. Nenhuma miniatura é publicada em URL externa.
