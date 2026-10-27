# Histórico de versões

## 1.1.2 (código 4) — em teste no aparelho

Exportação simples (substitui o modelo TOTVS):

- PDF, Excel e CSV trazem a mesma tabela: uma linha por unidade com Empresa, CNPJ, Inventário, PN, Descrição, NS, Quantidade, Patrimônio, Localização e Data da leitura. O PDF e o Excel também trazem a quantidade por PN e o total.
- Não há mais `SB1_Produtos.xlsx` nem as abas Identificação e Pendências; o catálogo SB1 continua servindo para reconhecer os PN e preencher a descrição.
- O e-mail automático leva dois anexos, o PDF e a planilha Excel, e o corpo traz a quantidade por PN. Se o PDF falhar, estiver vazio ou tiver tipo incorreto, nada é transmitido e o app permite tentar de novo. E-mails já enviados não são alterados nem reenviados automaticamente.
- A planilha Excel funciona também para todos os inventários da conta de uma vez.
- O CSV usa `;` como separador, o padrão do Excel em português.

Destinatário:

- O e-mail que recebe os inventários pode ser trocado: um padrão por conta em **Conta e dados** (inicialmente `lorena@ytechsolucoes.com`) e, em **Revisar e concluir**, outro e-mail digitado só para aquele inventário.
- O destinatário fica gravado com o inventário na conclusão e pode ser corrigido enquanto o envio está na fila ou depois de uma falha. Se mudar durante a montagem da mensagem, aquela tentativa não é transmitida e a próxima usa o novo endereço.
- Só um endereço simples é aceito (sem nome, lista ou quebra de linha), validado também na montagem do e-mail. Inventários concluídos em versões anteriores seguem para o destino original.
- Inventário já enviado ganhou **Reenviar e-mail**, para o mesmo endereço ou outro digitado na hora. O reenvio sai como uma nova mensagem, com o PDF e a planilha gerados de novo a partir das mesmas unidades e um Message-ID próprio, para o Gmail não escondê-lo como duplicata; sem internet, fica na fila. Inventário com dados gravados por versões antigas que não passam mais nas regras atuais não é reenviado e continua como enviado.

Leitor:

- PN já contado pela conta neste aparelho é aceito na primeira foto quando a leitura é o próprio PN (código ou texto, desconsiderando hífens, espaços e zeros lidos como O). Uma leitura apenas parecida (Z/2, S/5, B/8, G/6 ou um caractere de diferença) é sugerida como o PN contado, mas pede conferência com a etiqueta e uma segunda foto, porque pode ser um modelo irmão ou um erro de leitura salvo antes. Um PN salvo durante a leitura já vale para a unidade seguinte.
- Com várias etiquetas na foto, cada NS só é confirmado com o PN da própria etiqueta. Um modelo irmão ao lado de outro (ZT41142 e ZT41143) deixa de receber o PN da etiqueta vizinha, mesmo quando o código de barras do PN da vizinha fica colado ao texto dele, e o PN de uma etiqueta não substitui o de outra que ainda está sendo confirmado.
- Ao passar a câmera da unidade recém-salva para a próxima, o PN da anterior, mesmo lido só pelo leitor ao vivo, não é mais usado para a próxima, que espera o próprio PN. Uma sugestão de PN parecido nunca herda a confirmação de outra leitura, e um NS lido errado não impede o NS certo de receber o PN. PN de etiqueta sem NS continua completando o NS lido em seguida, inclusive quando PN e NS da mesma etiqueta são fotografados separadamente.

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
- "Exportar todos" deixa de fora, com aviso, um inventário que não pode ser lido, em vez de cancelar a exportação inteira.
- Voltar à lista e reabrir o mesmo inventário mostrava "0 unidades" e "Nenhum item contado" e escondia **Exportar ou compartilhar arquivo**, embora as unidades continuassem salvas; agora elas são recarregadas.

Projeto:

- Repositório git com CI (typecheck, lint e testes).
- `App.tsx` dividido em hooks, telas e um reducer de navegação; `shared/labels.ts` dividido em módulos; gerador de planilhas movido para `shared/`.
- TypeScript separado para app (sem tipos do Node), servidor e testes; lint com regras de hooks e de promessas não tratadas.
- Versão visível lida do `package.json`; o script de build confere se `android/` está alinhada com o projeto.
- A assinatura continua com a chave de debug, por decisão de distribuição só interna; ficam disponíveis `scripts/new-release-key.ps1` e `scripts/build-apk.ps1 -ReleaseKey` caso isso mude.
- Dependências: Expo 57.0.31, zod 4.6.7, TypeScript 6.0 e correções do servidor (express, nodemailer, express-rate-limit). `npm audit` sem alertas: node-forge 1.4.1 e o zod do `@expo/cli` forçado para 4.6.7 por `overrides`.
- Removido o gravador de diagnóstico de leituras, que não era usado.

## 1.1.1 (código 3)

- **Excluir inventário** dentro da coleta, perto da exportação. A confirmação mostra o nome e a quantidade de unidades e oferece exportar antes. A exclusão é local, em transação; e-mails enviados e arquivos exportados permanecem. Envios pendentes são cancelados, um envio em andamento bloqueia a exclusão e a fila confere de novo se o inventário existe antes de transmitir.
- Compilada em 22/10/2026 (`BUILD SUCCESSFUL`), `artifacts/YtechInvent-1.1.1.apk`. Assinatura verificada com `apksigner`; bibliotecas ARM de 32 e 64 bits; sem a flag de depuração. SHA-256: `553F0939D299FD41DDFB92C7C6E802A08235B5F3EC16678F46CE5D9FFC14829A`.

## 1.1.0 (código 2)

- Compilada em 22/10/2026 e instalada pelo usuário. Pacote `com.ytechsolucoes.invent`, JavaScript embutido, bibliotecas ARM de 32 e 64 bits, sem a flag de depuração; assinatura verificada com `apksigner`.
