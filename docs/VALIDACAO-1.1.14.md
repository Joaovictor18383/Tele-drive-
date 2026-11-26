# Validação do Tele Drive 1.1.14

Executada em 26/11/2026.

- `npm test`: 26 testes aprovados, sem falhas. Inclui contas, sessões, autenticação Telegram com provedores controlados, transferência em blocos, AES-GCM, Argon2id, recuperação, isolamento de contas, substituição atômica de notas e validação de miniaturas.
- `npm run build:web`: TypeScript e build de produção aprovados. O editor é um módulo carregado sob demanda de aproximadamente 3,3 kB, antes de gzip.
- `npm audit --omit=dev --audit-level=high`: nenhuma vulnerabilidade reportada na árvore auditada.
- Navegador Chromium, 1280 × 850 e perfil Android 393 × 850: menu vazio com exatamente quatro opções; notas criadas, reabertas, editadas e lidas após replay do índice; nomes e textos ausentes do journal cifrado; prévias de imagem e vídeo WebP geradas localmente; ausência de rolagem horizontal. Os testes usaram o Vault, Web Workers, Web Crypto, Transfers e componentes reais, com um transporte de arquivos isolado de teste. Não usaram arquivos pessoais ou uma conexão Telegram simulada em produção.
- Desbloqueio confiável: opt-in, vinculação ao cofre/cabeçalho, isolamento de escopo, desbloqueio de uma nova instância do Vault e remoção da autorização local conferidos. O registro protegido e o login sobreviveram ao encerramento completo e à reabertura do processo do Chromium nos perfis desktop e Android. Sair explicitamente encerrou o login.
- `npm run build:setup`: janela WebView2 aprovada pelo teste nativo. Manifesto Windows válido aceito e manifesto com versão adulterada rejeitado. O auxiliar do atualizador aguardou o processo fechar, conferiu SHA-256 e executou um instalador isolado de teste. Foi removida a dependência de Get-FileHash, indisponível em alguns ambientes herdados de PowerShell.
- PC local: instalado o binário final 1.1.14.0; SHA-256 do executável instalado coincide com o wrapper compilado.
- Produção: `/entrar` respondeu 200, CSP presente e service worker referenciando o módulo novo do bloco de notas.
- APK: assinatura v2/v3 validada com o certificado original, sem mudar o identificador do aplicativo.

## Limites desta verificação

Não foi usada sua conta Telegram para um novo envio real nesta rodada. A conta real já havia sido validada pelo usuário em uma etapa anterior. Persistência, notas e miniaturas foram testadas com criptografia real em um transporte isolado; isso não substitui teste de rede real, quotas ou revogação no Telegram.

Não houve acesso ao Xiaomi físico. A aprovação da instalação de APK e a autorização de instalação desta origem dependem do Android; o aplicativo não contorna essas permissões. A confiança no aparelho reduz os pedidos de senha mestra e depende da segurança do perfil local e do bloqueio de tela. Notas são limitadas a 2 MiB e a geração de miniaturas é limitada em tamanho e tempo; formatos sem decodificador usam ícones.

## Android 15 e publicação final

Workflow privado 45885210636: compilação e testes aprovados. O atalho antigo abriu a janela interna; o seletor de arquivos abriu, cancelou, reabriu e devolveu nome e 23 bytes do arquivo de teste ao formulário. Cookies e chave AES não exportável persistiram após force-stop. Manifesto assinado aceito e adulteração rejeitada. O teste do seletor não equivale a um upload real para uma conta Telegram.

Publicada a versão v1.1.14. APK interno 10114 / 1.1.14 confirmado. Os downloads públicos de APK, instalador e dois manifestos coincidiram com os SHA-256 dos arquivos locais. O alias CloudVaultSetup.exe também foi conferido no rascunho; ele é o mesmo instalador e atende aos atualizadores antigos.

