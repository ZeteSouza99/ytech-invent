# Ytech Invent

Aplicativo Android para inventário de equipamentos serializados da Ytech. Versão 1.1.2.

## Como funciona

O aplicativo coleta e guarda os dados no aparelho. O catálogo SB1 está embutido no APK; a exportação das planilhas também acontece localmente. O envio usa a Gmail API com a conta do responsável, para `lorena@ytechsolucoes.com`. O aplicativo atual não depende da API Node/SMTP existente na pasta `server`.

1. Entrar com a conta Google corporativa `@ytechsolucoes.com` (primeiro acesso online).
2. Criar uma coleta com nome e localização.
3. Ler a etiqueta ou digitar PN e número de série; conferir e salvar uma unidade.
4. Usar a busca por PN, NS ou localização para revisar as unidades.
5. Abrir **Revisar e concluir**, conferir os totais e as pendências e concluir.
6. Manter o app aberto e conectado para o envio pelo Gmail.

Cada conta acessa as próprias coletas. Sair não apaga dados; desinstalar ou limpar os dados apaga as coletas locais. Não existe sincronização de inventários entre aparelhos.

A partir da versão 1.1.2, o envio automático inclui três anexos: o relatório completo em PDF, `Inventario_Ytech.xlsx` e `SB1_Produtos.xlsx`. O PDF usa o mesmo gerador da exportação manual e contém todas as unidades da coleta concluída, incluindo PN fora do catálogo. Se a geração do PDF falhar, o e-mail não é transmitido e o app permite tentar novamente. No Excel, todas as unidades ficam na aba **Inventário**; a aba **Identificação** contém os dados da coleta. O SB1 continua limitado aos produtos conhecidos do catálogo. E-mails já enviados não são alterados nem reenviados automaticamente; para compartilhar o PDF de uma coleta já enviada, use a exportação manual.

## Leitor

`expo-camera` fornece a câmera e a leitura ao vivo. O módulo Kotlin `modules/label-reader` executa ML Kit localmente para códigos e texto, incluindo suas posições. `shared/labels.ts` combina essas evidências com o catálogo.

- Formatos ativos: Code 128, Code 39, Data Matrix e PDF417.
- PN e NS são associados por rótulos, identificadores e posição na imagem.
- O classificador descarta campos como MAC, IP, data e quantidade.
- Há correções de caracteres semelhantes (O/0, S/5 etc.) e aproximação ao catálogo. A confiança e a repetição entre fotos ajudam a decidir; isso não substitui conferir a etiqueta.
- Com várias etiquetas, uma claramente centralizada pode ser priorizada; em casos ambíguos o app pede escolha.
- Manter PN facilita lotes do mesmo modelo. Um PN diferente detectado bloqueia a associação automática.
- Uma foto permanece sob controle da operação até a análise e a tentativa de exclusão terminarem. Fechar o leitor aguarda essa operação. Falha de limpeza pausa a captura e exige ciência do aviso.
- Fotos de OCR não são enviadas ao Gmail.

## Dados e fila

SQLite local com WAL e gravação síncrona FULL. Sessão armazenada com SecureStore. O banco não é criptografado; o backup automático Android está desabilitado.

- Uma unidade por NS; PN e NS não podem ser iguais.
- NS único por inventário, com zeros iniciais preservados.
- Até 10.000 unidades ou 8 MiB de dados por inventário.
- A conclusão valida e congela a coleta antes de qualquer tentativa de rede.
- Estados: `draft`, `queued`, `sending`, `sent`, `failed`, `uncertain`.
- A fila tenta enviar a cada 30 segundos em primeiro plano e com internet.
- Falhas conhecidas exigem tentativa explícita. Queda de conexão, interrupção, HTTP 408/5xx ou resposta sem ID da mensagem ficam como envio a conferir.
- Reenviar um resultado incerto exige conferir primeiro a pasta Enviados; o Message-ID fixo não garante que o Gmail elimine duplicatas.
- Sessão inválida ou recibo ilegível não devem derrubar a interface nem apagar unidades.

## Exportação sem Gmail

**Exportar ou compartilhar arquivo** permite escolher PDF, CSV, JSON ou Excel. Salvar em uma pasta usa o seletor do Android; compartilhar abre os aplicativos instalados. No formato Excel, salvar inclui as duas planilhas; compartilhar permite escolher o relatório ou o SB1. A geração funciona offline e não altera o estado do envio pelo Gmail.

PDF contém empresa, CNPJ, tipo, PN, NS, patrimônio opcional e localização. CSV oferece uma linha por unidade, com campos escapados e proteção contra fórmulas. JSON preserva os identificadores e os dados completos. Em **Conta e dados**, é possível exportar todas as coletas com unidades ou restaurar um backup JSON do **Ytech Invent**. O formato JSON tem identificação/versão própria e não importa automaticamente arquivos do inventapp. Limite de restauração: 32 MB e 1.000 inventários; arquivos acima desses limites não são gerados como backup conjunto. Inventários restaurados ficam em coleta, sem envio automático; IDs existentes são ignorados e a operação é atômica. Coletas vazias não são incluídas na exportação.

Inventários novos possuem tipo **Interno** ou **Externo**. Interno preenche **YTECH SOLUÇÕES — 09.310.663/0001-87**, informado pelo usuário. Externo exige nome e CNPJ válido do cliente. O validador suporta CNPJ numérico e alfanumérico. A identificação é persistida na coleta e incluída no relatório Excel, PDF, CSV, JSON e corpo do e-mail; não altera o layout de importação SB1. Coletas antigas sem empresa continuam legíveis, com identificação não informada até serem editadas.

Uma coleta aberta pode gerar **cópia parcial** sem bloquear novas leituras. Os nomes dos arquivos e a aba Identificação sinalizam que ela é parcial. Os nomes incluem ID e horário para distinguir exportações. Falha durante a gravação tenta remover somente os arquivos criados nessa tentativa e avisa se restarem arquivos incompletos.

Na versão 1.1.1, **Excluir inventário** aparece dentro da coleta, próximo à exportação. A confirmação informa o nome e a quantidade de unidades e oferece exportar antes. A exclusão remove somente os dados locais daquela conta, em uma transação; e-mails enviados e arquivos exportados permanecem. Envios ainda pendentes são cancelados pela exclusão. Um envio em andamento bloqueia a operação até terminar. A fila verifica novamente a existência do inventário antes de transmitir.

Ao compartilhar arquivos manualmente, confira se o inventário também está na fila automática para evitar envio duplicado.

### SB1_Produtos.xlsx

Preserva o modelo e as abas Produtos, Grupos e Endereço. Exporta uma linha por produto conhecido e não ambíguo, sem inventar cadastros para PN desconhecido. Campos originais e pendências são preservados para revisão. Localização física não preenche automaticamente B1_LOCPAD.

### Inventario_Ytech.xlsx

Abas Identificação, Inventário, Resumo e Pendências. Registra identificação e versão do catálogo, séries, unidades, localização, origem, responsável e horários. Não é um layout homologado para importação de saldo/séries no TOTVS.

O catálogo é `assets/catalog/sb1-produtos.xlsx`; atualizá-lo exige novo APK. A exportação avisa quando uma coleta usa versão anterior do catálogo.

## Configuração Google

O aplicativo usa `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` em `.env`. Nunca coloque senhas em variáveis `EXPO_PUBLIC_*`, pois elas entram no APK.

No Google Cloud: Gmail API ativada; cliente Web; cliente Android para `com.ytechsolucoes.invent` com SHA-1 da chave efetivamente usada; consentimento e autorização do escopo `https://www.googleapis.com/auth/gmail.send` para as contas corporativas. O app não lê a caixa de entrada, não requer senha Gmail nem SMTP.

O usuário informou em 22/10/2026 que login, envio e recebimento reais já foram testados e funcionam. Isso se refere ao fluxo já existente; as alterações novas de interface, exportação e câmera ainda precisam de conferência no dispositivo.

## Compilar o APK para instalação manual

Requisitos: Node 24, dependências instaladas, SDK Android com os componentes do projeto e JDK 17. O script procura primeiro `.tools/jdk/jdk-17.0.16`, depois usa JAVA_HOME.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run apk
```

Com dependências Gradle já em cache:

```powershell
.\scripts\build-apk.ps1 -Offline
```

O script prepara uma cópia em `%TEMP%\yi-apk`, usa cache `%TEMP%\yi-gradle` e compila `assembleRelease`. Por padrão inclui ARM de 64 e 32 bits. O APK contém JavaScript e catálogo; não precisa do Metro. Saída: `artifacts\YtechInvent-1.1.2.apk`.

Com um único aparelho conectado e autorizado no ADB, `powershell.exe -NoProfile -File scripts/check-device.ps1` coleta resolução, densidade, escala de fonte, versão instalada, captura de tela e hierarquia visual em `artifacts/device-check`. Execute com o aparelho desbloqueado. O script abre o app, sem alterar tamanho de tela ou escala de fonte, e não cria nem exclui inventários. O funcionamento normal do app pode processar envios já pendentes ao ser aberto.

Por decisão do usuário, a distribuição manual usa a chave debug já existente em `android/app/debug.keystore`, sem criar outra chave e sem publicação em loja. Preservar pacote e chave permite atualização da instalação compatível. O Android exige assinatura técnica mesmo para instalação manual. Se a instalação existente usar outra chave, não desinstale antes de exportar as coletas.

O comando `npm.cmd run build` continua sendo o build da API Node, não do APK.

## Desenvolvimento e testes

`npm.cmd start` inicia o Metro apenas para desenvolvimento do código. `npm.cmd run android` usa a variante release. Expo Go não suporta o módulo próprio. O aplicativo não oferece mais entrada de câmera sem login, telas de diagnóstico ou deep link de avaliação; o pacote expo-dev-client foi removido.

O leitor não chama mais o gravador de diagnóstico e não registra PN/NS/texto de etiquetas em logs. Arquivos de teste permanecem como ferramentas de validação do código, fora do fluxo do aplicativo. Release usa `debuggable false`, JavaScript embarcado, Gmail real e o catálogo real. O estado de publicação do consentimento OAuth no Google Cloud é uma configuração externa e não é alterado por variáveis do APK.

Validação local da versão 1.1.2: 150 testes automatizados, lint e TypeScript aprovados. Os novos testes verificam os três anexos na mensagem, a preservação de todas as unidades no Excel e a interrupção antes do envio quando o PDF falha, está vazio ou tem tipo incorreto. O renderizador nativo de PDF é simulado nos testes; o envio real dos três anexos ainda precisa de conferência no aparelho após compilar e instalar a atualização (código 4). Nenhum e-mail de teste foi enviado nesta validação.

A compilação da versão 1.1.1 iniciada pelo usuário concluiu em 22/10/2026 com `BUILD SUCCESSFUL` e gerou `artifacts/YtechInvent-1.1.1.apk` (código 3). Esse APK ainda não inclui o PDF no envio automático. A assinatura foi validada com `apksigner`, o pacote e as bibliotecas ARM de 32 e 64 bits foram conferidos, e a flag de depuração está ausente. SHA-256: `553F0939D299FD41DDFB92C7C6E802A08235B5F3EC16678F46CE5D9FFC14829A`.

A coleta local de diagnóstico identificou Motorola edge 60 fusion, Android 16, tela física 1220 × 2712, densidade 450 e escala de fonte 0,85. Na coleta, a versão instalada ainda era 1.1.0. O teste visual automatizado permanece pendente: a consulta ADB nesta sessão foi bloqueada ao tentar criar `\.android`, e a captura da janela espelhada do Smart Connect não mostrou a área correta.

Em 22/10/2026, a compilação anterior iniciada no PowerShell local concluiu com `BUILD SUCCESSFUL` e gerou `artifacts/YtechInvent-1.1.0.apk` (versão 1.1.0, código 2), instalada pelo usuário. A assinatura desse APK foi verificada com `apksigner`; o pacote é `com.ytechsolucoes.invent`, contém JavaScript embarcado e bibliotecas ARM de 32 e 64 bits, sem a flag de depuração. O APK 1.1.0 não contém a nova exclusão de inventários.

Os testes cobrem contratos, SQLite, fila, classificação de etiquetas, resultados registrados de fotos reais, planilhas, Gmail simulado, exportação e cancelamento/limpeza de capturas. O teste das fotos reproduz dados do ML Kit, não executa a câmera nativa. Testes unitários não substituem a conferência no celular.

## API alternativa preservada

`server/` contém Express 5, validação de Google ID token, SQLite Node e Nodemailer. Rotas: GET `/health`, GET `/bootstrap`, POST `/inventories`, GET `/inventories/:id`, POST `/inventories/:id/retry`. Somente `/health` é público. O servidor reusa as regras e o exportador, mas não participa do fluxo móvel atual.

Para usar essa alternativa, configure as variáveis opcionais de servidor em `.env.example`, execute `npm.cmd run build` e `npm.cmd run server:prod`. Ela requer infraestrutura própria e uma instância por banco; não é necessária para instalar ou usar este APK.
