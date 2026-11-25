# CloudVault para Android

O Android usa a mesma interface e criptografia local da edição web. A aplicação precisa de uma instância CloudVault HTTPS alcançável pelo celular, com Fastify e as credenciais do Telegram. O servidor que hospeda o site também entrega a API e mantém as sessões MTProto protegidas.

## Instalar no celular

1. Siga as [instruções de hospedagem](../README.md#publicação) e o [cadastro no Telegram](../README.md#telegram). Para abrir um cofre existente, a instância precisa usar o API Hash original do cofre.
2. Confirme que o endereço funciona e tem os arquivos de instalação. Requer Node.js 22.13 ou superior.

   ```sh
   node android/check.mjs https://vault.seudominio.com
   ```

3. No Chrome para Android, abra o endereço da sua instância. No menu, escolha **Instalar app** ou **Adicionar à tela inicial → Instalar**.
4. Abra o CloudVault pelo ícone e conclua o login oficial do Telegram. Quando aparecer o QR, use outro aparelho em que o Telegram já esteja conectado à mesma conta e leia o código em **Configurações → Dispositivos → Conectar dispositivo**. Com um só celular, espelhe a tela do CloudVault em um monitor que só você controla e use a câmera do Telegram para ler o código.
5. Desbloqueie o cofre com sua senha mestra. Em **Meu Drive**, use **Enviar arquivos** para validar o envio e faça o download de um arquivo para conferir.

## Gerar o APK assinado

Use o Bubblewrap, mantido pelo Chrome, em um diretório de build fora do código-fonte ou em `.bubblewrap/`, que já está no `.gitignore`. O endereço abaixo deve ser substituído pelo domínio que hospeda o CloudVault. A ferramenta pode instalar o JDK e o SDK do Android no primeiro uso.

```sh
mkdir .bubblewrap
cd .bubblewrap
npx --yes @bubblewrap/cli@1.27.0 init --manifest=https://vault.seudominio.com/manifest.webmanifest
npx --yes @bubblewrap/cli@1.27.0 build
```

Use `io.github.joaovictor18383.cloudvault` como ID do pacote para este repositório. Guarde o keystore, o alias e as senhas em local seguro. Use a mesma chave para assinar atualizações. O Bubblewrap gera `app-release-signed.apk` para instalação direta e `app-release-bundle.aab` para distribuição em loja.

Sirva o `assetlinks.json` produzido pelo Bubblewrap em `https://vault.seudominio.com/.well-known/assetlinks.json` pelo proxy HTTPS. Use o certificado que assina o APK distribuído. O vínculo habilita a abertura em tela cheia sem barra de navegação. Confirme a associação e faça um teste completo em um celular antes de anexar o APK a uma release.

```sh
cd ..
node android/check.mjs https://vault.seudominio.com AA:BB:CC:...
adb install .bubblewrap/app-release-signed.apk
```

Substitua o exemplo pela impressão digital SHA-256 completa com 32 pares hexadecimais.

[Guia oficial de Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start) · [Assinatura e Digital Asset Links](https://developer.chrome.com/docs/android/trusted-web-activity/android-for-web-devs)
