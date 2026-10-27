# Ytech Invent

Aplicativo Android para inventário de equipamentos serializados da Ytech. Versão 1.1.2 (código 4). O histórico de versões está em [CHANGELOG.md](CHANGELOG.md).

## Como funciona

Tudo acontece no aparelho: os dados ficam num banco local criptografado, o catálogo de produtos vem embutido no APK e o PDF, a planilha Excel e o CSV são gerados no próprio celular. O envio usa a Gmail API com a conta do responsável, para `lorena@ytechsolucoes.com`. O app não depende da API da pasta `server/`.

1. Entrar com a conta Google corporativa `@ytechsolucoes.com` (o primeiro acesso precisa de internet).
2. Criar uma coleta com nome, localização e empresa (interno ou externo).
3. Ler a etiqueta ou digitar PN e número de série (NS), conferir e salvar cada unidade.
4. Buscar por PN, NS ou localização; editar localização e patrimônio de uma unidade ou removê-la.
5. Abrir **Revisar e concluir**, conferir os totais e concluir.
6. O envio pelo Gmail acontece com o app aberto e conectado e, quando o Android permite, também em segundo plano.

Cada conta acessa só as próprias coletas. Sair não apaga dados; desinstalar ou limpar os dados do app apaga as coletas. Não há sincronização entre aparelhos.

## Leitor de etiquetas

`expo-camera` fornece a câmera e a leitura ao vivo. O módulo Kotlin [modules/label-reader](modules/label-reader) roda o ML Kit no aparelho para códigos e texto, com a posição de cada um. [shared/labels](shared/labels) combina essas evidências com o catálogo.

- Formatos: Code 128, Code 39, Data Matrix e PDF417.
- PN e NS são associados por rótulos impressos (P/N, S/N), identificadores (1P, S, GS1) e posição na imagem. MAC, IP, datas e quantidades são descartados.
- Há correção de caracteres parecidos (O/0, S/5) e aproximação ao catálogo. Uma leitura provável só é aceita quando se repete em outra foto; isso não substitui conferir a etiqueta.
- **PN já contado:** os PN que a conta já salvou neste aparelho, em qualquer inventário, são aceitos na primeira foto, sem esperar confirmação. Isso vale para o código de barras, para o texto depois de "P/N" (inclusive com um caractere lido errado pelo OCR, que é corrigido para o PN conhecido) e para o PN impresso sem rótulo. Um PN salvo durante a leitura passa a valer já na unidade seguinte. O NS lido só pelo texto continua precisando de duas fotos iguais, para evitar dígitos trocados.
- Com várias etiquetas na imagem, a central pode ser priorizada; nos casos ambíguos o app pede escolha.
- "Manter PN" agiliza lotes do mesmo modelo; um PN diferente detectado bloqueia a associação automática.
- Cada foto é apagada depois da análise, mesmo em erro ou cancelamento. Fotos não são enviadas nem registradas em logs.

## Dados, segurança e envio

**Banco local.** SQLite com SQLCipher (AES-256), WAL e gravação síncrona FULL. A chave é aleatória (256 bits), criada no primeiro uso e guardada no SecureStore (Android Keystore). O backup automático do Android está desligado.

- Na primeira abertura da versão 1.1.2, o banco antigo sem criptografia (`ytech-invent.db`) é copiado para `ytech-invent-secure.db`. A cópia é conferida (contagem de coletas e unidades e `PRAGMA quick_check`) antes de o arquivo antigo ser apagado. Se a cópia falhar, o app continua com o banco antigo, avisa e tenta de novo na próxima abertura.
- Se a chave se perder, as coletas criptografadas não podem ser abertas. O app avisa e não apaga nada; não desinstale nem limpe os dados nesse caso.
- O esquema do banco é versionado com `PRAGMA user_version`. Um banco gravado por uma versão mais nova do app não é aberto.
- Todas as gravações passam por uma única fila, e operações compostas (excluir, restaurar backup, migrar) rodam em transação.

**Regras da coleta.**

- Uma unidade por NS, NS único por inventário (zeros à esquerda preservados), PN diferente do NS.
- Até 10.000 unidades ou 8 MiB de dados por inventário. Os testes cobrem uma coleta completa nesse limite.
- Uma leitura com horário anterior ao início da coleta é recusada (relógio do aparelho atrasado). A conclusão nunca fica antes da última leitura, então corrigir o relógio depois não impede concluir ou exportar.
- Dados gravados por versões antigas que não seguem mais as regras atuais continuam visíveis e marcados para reparo, sem travar as demais coletas nem a fila. Concluir e exportar sempre usam as regras atuais.

**Envio.** A conclusão valida e congela a coleta antes de qualquer acesso à rede.

- Estados: `draft` (em coleta), `queued`, `sending`, `sent`, `failed`, `uncertain` (envio a conferir).
- Com o app aberto, a fila é tentada a cada 30 segundos quando há internet. Com o app fechado, o Android executa a fila em segundo plano no mínimo a cada 15 minutos, quando há rede; o horário exato é decidido pelo sistema. Em segundo plano, o que depende da tela ou da conta (gerar o PDF, renovar o login) fica na fila para a próxima tentativa com o app aberto. Criar, migrar ou recuperar o banco local só acontece com o app aberto.
- O estado `sending` é gravado antes de transmitir. Queda de conexão, interrupção, HTTP 408/5xx ou resposta sem ID da mensagem ficam como `uncertain`; reenviar exige conferir a pasta Enviados, porque o Message-ID fixo não garante que o Gmail elimine duplicatas.
- Falhas conhecidas (`failed`) exigem uma nova tentativa explícita.
- Dois anexos: o relatório em PDF e a planilha Excel descritos em [Exportação](#exportação-e-backup); o corpo do e-mail traz a quantidade por PN. Se o PDF falhar, nada é transmitido.

## Exportação e backup

**Exportar ou compartilhar arquivo** gera PDF, Excel, CSV ou JSON, sem internet e sem alterar o envio pelo Gmail. Salvar usa o seletor de pastas do Android; compartilhar abre os apps instalados. Os três formatos de relatório funcionam para um inventário ou para todos os inventários da conta (em **Conta e dados**).

- Colunas (uma linha por unidade, na ordem da leitura): Empresa, CNPJ, Inventário, PN, Descrição, NS, Quantidade, Patrimônio, Localização e Data da leitura. A descrição vem do catálogo; PN fora do catálogo fica sem descrição.
- PDF: cabeçalho com empresa, CNPJ, tipo, localização, datas e totais; a tabela de unidades; e a quantidade por PN com o total.
- Excel: aba **Inventário** com as colunas acima (PN, NS e patrimônio como texto, para manter zeros à esquerda) e aba **Resumo** com a quantidade por PN e o total.
- CSV: as mesmas colunas, separadas por `;` (o padrão do Excel em português), com campos escapados e proteção contra fórmulas. Ao abrir um CSV no Excel, códigos só com números podem perder os zeros à esquerda; use o Excel quando isso importar.
- JSON: backup completo do Ytech Invent. Em **Conta e dados** é possível exportar todas as coletas com unidades ou restaurar um backup (até 32 MB e 1.000 inventários; coletas vazias não entram). Coletas restauradas ficam em coleta, sem envio automático; IDs existentes são ignorados e a restauração é tudo ou nada.
- Uma coleta aberta gera **cópia parcial**, sinalizada no nome do arquivo e no PDF.
- Ao compartilhar manualmente, confira se a coleta também está na fila automática, para não enviar em dobro.

Inventários têm tipo **Interno** (YTECH SOLUÇÕES — 09.310.663/0001-87) ou **Externo** (nome e CNPJ do cliente, numérico ou alfanumérico). A identificação vai para o PDF, a planilha, o CSV, o JSON e o corpo do e-mail.

**Excluir inventário** fica dentro da coleta. A exclusão é local e atômica; e-mails enviados e arquivos exportados permanecem. Um envio pendente é cancelado; um envio em andamento bloqueia a exclusão.

## Catálogo de produtos

O catálogo embutido é [assets/catalog/sb1-produtos.xlsx](assets/catalog/sb1-produtos.xlsx), a lista de produtos no formato SB1. Ele serve para reconhecer os PN na leitura e preencher a descrição nos relatórios; não há mais exportação no layout do TOTVS. O arquivo precisa da aba **Produtos** com `B1_COD`, `B1_XPART` e `B1_DESC` nas colunas A a C da linha 2 e os produtos a partir da linha 4. A aba **Endereço**, se existir, sugere localizações ao criar uma coleta. Um PN repetido com descrições diferentes fica sem descrição, com aviso em **Conta e dados**.

Em **Conta e dados → Importar catálogo SB1 (.xlsx)** é possível trocá-lo sem gerar outro APK: o arquivo é validado antes de substituir o atual e fica guardado no aparelho. **Voltar ao catálogo embutido** desfaz a troca.

## Configuração Google

O app usa `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` do `.env` (veja [.env.example](.env.example)). Nunca coloque senhas em variáveis `EXPO_PUBLIC_*`: elas entram no APK.

No Google Cloud: Gmail API ativada; cliente OAuth Web; cliente OAuth Android para `com.ytechsolucoes.invent` com o SHA-1 de cada chave que assina o app; escopo `https://www.googleapis.com/auth/gmail.send` autorizado para as contas corporativas. O app não lê a caixa de entrada nem usa senha ou SMTP.

## Assinatura do APK

Os APKs são assinados com `android/app/debug.keystore`, a chave de debug padrão do template React Native (SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`). Essa chave é pública: qualquer pessoa pode assinar um APK `com.ytechsolucoes.invent` que o Android aceita como atualização, com acesso aos dados do app. Por decisão do responsável (27/10/2026), a distribuição continua com ela porque o APK circula só entre funcionários da Ytech.

Se o APK passar a circular fora da empresa, migre para uma chave privada:

1. Rode `powershell.exe -NoProfile -File scripts/new-release-key.ps1`. Ele cria `%USERPROFILE%\.ytech-invent\ytech-invent-release.jks` (fora do projeto e do OneDrive), pede a senha e mostra o SHA-1. Guarde o arquivo e a senha em local seguro: sem eles não há como atualizar o app instalado.
2. No Google Cloud, crie um cliente OAuth Android com o mesmo pacote e o SHA-1 novo, **sem remover o atual**.
3. Escolha como atualizar os aparelhos que já têm o app:
   - **Rotação de chave (mantém os dados, Android 9 ou superior).** Gere o APK normalmente e assine de novo com `apksigner` (Android SDK build-tools): crie a linhagem uma vez com `apksigner rotate --out lineage.bin --old-signer --ks android\app\debug.keystore --ks-pass pass:android --new-signer --ks %USERPROFILE%\.ytech-invent\ytech-invent-release.jks` e assine com `apksigner sign --ks android\app\debug.keystore --ks-pass pass:android --next-signer --ks %USERPROFILE%\.ytech-invent\ytech-invent-release.jks --lineage lineage.bin --rotation-min-sdk-version 28 --out YtechInvent-rotacionado.apk artifacts\YtechInvent-<versão>.apk`. Confira com `apksigner verify --print-certs -v` e teste num aparelho antes de distribuir. Guarde `lineage.bin` junto da chave.
   - **Reinstalação.** Exporte todas as coletas (JSON) e confira o arquivo, desinstale, instale o APK gerado com `scripts\build-apk.ps1 -ReleaseKey` e restaure o backup. Coletas restauradas voltam como abertas; os estados de envio não são restaurados.
4. Depois que todos os aparelhos estiverem na chave nova, use `scripts\build-apk.ps1 -ReleaseKey` nas próximas versões. Um APK assinado só com a chave nova não instala por cima de um assinado com a chave de debug: o Android recusa a instalação e não apaga nada.

## Compilar o APK

Requisitos: Node 24, dependências instaladas, SDK Android e JDK 17 (o script usa `.tools/jdk/jdk-17.0.16` ou `JAVA_HOME`).

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run apk          # ou .\scripts\build-apk.ps1 -Offline com o cache do Gradle pronto
```

O script compila uma cópia em `%TEMP%\yi-apk` (cache em `%TEMP%\yi-gradle`), gera `assembleRelease` para ARM de 64 e 32 bits e grava `artifacts\YtechInvent-<versão>.apk` com o SHA-256. O APK traz JavaScript e catálogo embutidos; não precisa do Metro.

A pasta `android/` é gerada pelo Expo e não é versionada. Antes de compilar, o script confere se ela está alinhada com o projeto (versão, SQLCipher e bloco de assinatura) e para com instruções se não estiver. Para regenerá-la, use `npx.cmd expo prebuild --platform android --no-install` **sem** `--clean`, que apagaria a `debug.keystore` usada até a migração da chave.

**Versão.** O número visível vem só do `package.json`; o `versionCode` fica em [app.config.ts](app.config.ts) e precisa aumentar a cada APK distribuído.

`scripts/check-device.ps1`, com um único aparelho conectado e autorizado no ADB, coleta resolução, densidade, escala de fonte, versão instalada, captura de tela e hierarquia visual em `artifacts/device-check`, sem criar nem excluir dados.

## Desenvolvimento

| Pasta | Conteúdo |
|---|---|
| [App.tsx](App.tsx) | Raiz: junta os hooks, as ações e as telas |
| [src/app](src/app) | Hooks de sessão, catálogo, dados, conectividade e fila; navegação (reducer) |
| [src/screens](src/screens) | Telas e o estado do formulário de digitação |
| [src](src) | Banco (`repository`, `database`), fila (`outbox`, `delivery`, `backgroundSend`), catálogo, exportação, leitor |
| [shared](shared) | Regras de negócio sem React Native: modelo (zod), empresa, etiquetas, relatório (`report`), planilha, MIME, Gmail |
| [modules/label-reader](modules/label-reader) | Módulo nativo Kotlin com ML Kit |
| [server](server) | API alternativa (veja abaixo) |
| [tests](tests) | Vitest em Node; `fixtures/` traz a saída real do ML Kit para as fotos de etiquetas |

- `npm.cmd start` inicia o Metro para desenvolvimento; o Expo Go não suporta o módulo próprio.
- `npm.cmd run typecheck` confere três configurações: [tsconfig.json](tsconfig.json) (app, sem tipos do Node, como no Hermes), [tsconfig.server.json](tsconfig.server.json) e [tsconfig.test.json](tsconfig.test.json).
- O lint inclui as regras de hooks do React e de promessas não tratadas.
- O [CI](.github/workflows/ci.yml) roda typecheck, lint e testes a cada push e pull request.
- As fotos originais das etiquetas ficam em `tests/fixtures/photos`, só na máquina local (fora do git). O teste que compara o modelo embutido com a planilha original da raiz roda só localmente.

Os testes cobrem contratos, banco e fila, migrações, leitura tolerante, envio em segundo plano, classificação de etiquetas com a saída real do ML Kit (inclusive com PN já contados), PDF, planilha, CSV, e-mail, catálogo importado e uma coleta de 10.000 unidades. Câmera, ML Kit nativo, SQLCipher, WorkManager e geração nativa do PDF só podem ser conferidos no aparelho.

## Conferência no aparelho (pendente)

Itens da 1.1.2 que os testes automatizados não cobrem:

1. Atualizar por cima da 1.1.1 com coletas salvas e conferir que todas continuam lá (migração para o banco criptografado).
2. Concluir uma coleta, fechar o app e verificar o envio em segundo plano; conferir o PDF e a planilha no e-mail recebido.
3. Ler duas unidades seguidas do mesmo modelo: a segunda deve ficar pronta já na primeira foto (PN já contado).
4. Importar um catálogo SB1, ler um PN que só existe nele e voltar ao embutido.
5. Editar localização e patrimônio de uma unidade; compartilhar e salvar exportações em PDF, Excel, CSV e JSON, e abrir o CSV no Excel.
6. Uma coleta grande (milhares de unidades): tempo para salvar cada unidade, concluir e gerar o PDF.

O usuário informou em 22/10/2026 que login, envio e recebimento reais funcionavam na 1.1.1. Aparelho de referência: Motorola edge 60 fusion, Android 16, tela 1220 × 2712, densidade 450, escala de fonte 0,85.

## API alternativa preservada

`server/` contém Express 5, validação de Google ID token, SQLite do Node e Nodemailer. Rotas: GET `/health`, GET `/bootstrap`, POST `/inventories`, GET `/inventories/:id`, POST `/inventories/:id/retry`; só `/health` é pública. Ela usa as mesmas regras e a mesma planilha simples de [shared](shared) (envia só a planilha, sem PDF), mas não participa do fluxo do app. Para usá-la, configure as variáveis de servidor do `.env.example`, rode `npm.cmd run build` e `npm.cmd run server:prod`. Requer infraestrutura própria e uma instância por banco.
