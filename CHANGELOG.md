# Histórico de versões

## 1.1.2 (código 4) — não compilada para distribuição

Envio automático com relatório PDF:

- O e-mail passa a ter três anexos: relatório completo em PDF (o mesmo da exportação manual, com todas as unidades, inclusive PN fora do catálogo), `Inventario_Ytech.xlsx` e `SB1_Produtos.xlsx`. Se o PDF falhar, estiver vazio ou tiver tipo incorreto, nada é transmitido e o app permite tentar de novo.
- E-mails já enviados não são alterados nem reenviados.

Segurança e dados:

- Banco local criptografado com SQLCipher; a chave fica no SecureStore. O banco da versão anterior é copiado, conferido e só então apagado.
- Leitura tolerante: dados antigos que não seguem as regras atuais aparecem marcados para reparo, sem travar a lista nem a fila de envio.
- Leituras com horário anterior ao início da coleta são recusadas; corrigir o relógio depois não impede concluir ou exportar.
- Migrações do banco numeradas com `PRAGMA user_version`; o app não abre dados de uma versão mais nova.
- Todas as gravações passam por uma única fila; exclusão, restauração e migração rodam em transação.

Funcionalidades:

- Envio em segundo plano pelo Android (mínimo de 15 minutos entre tentativas, com rede).
- Edição de localização e patrimônio de uma unidade salva.
- Importação de catálogo SB1 pelo app, com volta ao catálogo embutido.
- Mensagens de validação em português.
- Coletas grandes: salvar uma unidade não recarrega mais todas as unidades, e a fila só recarrega a lista quando algo muda.

Correções:

- Nome do remetente com vírgula ou outros sinais de endereço passa a ir entre aspas no cabeçalho `From`.
- No compartilhamento do Excel, a planilha é escolhida pelo nome, não pela posição.

Projeto:

- Repositório git com CI (typecheck, lint e testes).
- `App.tsx` dividido em hooks, telas e um reducer de navegação; `shared/labels.ts` dividido em módulos; gerador de planilhas movido para `shared/`.
- TypeScript separado para app (sem tipos do Node), servidor e testes; lint com regras de hooks e de promessas não tratadas.
- Versão visível lida do `package.json`; o script de build confere se `android/` está alinhada com o projeto.
- Preparação para a chave de assinatura privada: `scripts/new-release-key.ps1` e `scripts/build-apk.ps1 -ReleaseKey`.
- Dependências: Expo 57.0.31, zod 4.6.7, TypeScript 6.0 e correções do servidor (express, nodemailer, express-rate-limit).
- Removido o gravador de diagnóstico de leituras, que não era usado.

## 1.1.1 (código 3)

- **Excluir inventário** dentro da coleta, perto da exportação. A confirmação mostra o nome e a quantidade de unidades e oferece exportar antes. A exclusão é local, em transação; e-mails enviados e arquivos exportados permanecem. Envios pendentes são cancelados, um envio em andamento bloqueia a exclusão e a fila confere de novo se o inventário existe antes de transmitir.
- Compilada em 22/10/2026 (`BUILD SUCCESSFUL`), `artifacts/YtechInvent-1.1.1.apk`. Assinatura verificada com `apksigner`; bibliotecas ARM de 32 e 64 bits; sem a flag de depuração. SHA-256: `553F0939D299FD41DDFB92C7C6E802A08235B5F3EC16678F46CE5D9FFC14829A`.

## 1.1.0 (código 2)

- Compilada em 22/10/2026 e instalada pelo usuário. Pacote `com.ytechsolucoes.invent`, JavaScript embutido, bibliotecas ARM de 32 e 64 bits, sem a flag de depuração; assinatura verificada com `apksigner`.
