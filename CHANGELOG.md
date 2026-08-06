# Changelog — 6 de agosto de 2026

Resumo do trabalho feito hoje no Sebinta (antigo Filepad), da rebrand até às releases `v1.4.0`–`v1.7.0`.

## Rebrand: Filepad → Sebinta

- Nome, ícone (caderno de espiral), títulos de janela, logs, canais IPC e nomes de ficheiros de dados (`filepad.db`/`filepad.log` → `sebinta.db`/`sebinta.log`) atualizados em todas as versões: web, servidor Node, servidor standalone em Go, CLI e app desktop.
- Repositório GitHub renomeado duas vezes: `RampGamer/filepad` → `RampGamer/sebinta` → `RampGamer/Sebinta` (maiúscula). O GitHub redireciona automaticamente clones e links antigos.
- `go.mod`, links do README e nomes de módulo atualizados para o novo caminho do repositório.

## Cabeçalho do pad e separadores no desktop

- Caminho do pad passou a ser um campo editável (📂 + caixa de texto + "Ir") na mesma linha do Password/Limpar pad, em vez de um nome fixo com um botão de limpar metadados à parte.
- Editor deixou de ter caixa visível (sem borda, sem contraste de fundo) e passou a preencher a janela toda.
- App desktop ganhou um sistema de separadores estilo browser — um `<webview>` por separador, cada um com a sua própria ligação em tempo real, trocar é instantâneo. O botão ⚙ (mudar servidor) passou para o canto esquerdo da faixa de separadores, por ser uma definição da janela e não de um pad específico. Separadores abertos ficam guardados entre arranques.
- Corrigido um bug de especificidade CSS em que a página inicial (escolher nome de pad) por vezes não desaparecia depois de um pad carregar (`[hidden]` a perder para uma regra de autor com `display:flex`).

## Logótipo "Sebinta" e o easter egg do tema caderno

- Adicionado um logótipo "sebinta" centrado no cabeçalho (grelha de 3 colunas: campo do pad + estado à esquerda, logo ao centro, ações à direita), com o "bin" destacado a marca-texto — referência direta à etimologia do nome (Sebenta + **bin**ário).
- Clicar no logótipo é um easter egg: troca a página toda para um tema "caderno" — papel pautado com margem vermelha no editor, ficheiros como post-its coloridos, botões Password/Limpar pad como carimbos de tinta, espiral de caderno na margem esquerda. Tudo via uma classe `body.theme-notebook` a reskinnar o DOM real (sem duplicar markup). A escolha fica guardada por browser (`localStorage`) e aplica-se antes do primeiro render, para não haver flash do tema errado.
- Depois de comparar a implementação real lado a lado com o mockup de design, foram corrigidos vários problemas de fidelidade:
  - As fontes do tema (Caveat, Permanent Marker) estavam a falhar silenciosamente — `/fonts/*` devolvia a página do pad em vez do ficheiro da fonte, por faltar a rota estática e por "fonts" não estar na lista de segmentos reservados para IDs de pad. Corrigido em paralelo no servidor Node (`server/index.js`, `services/padStore.js`) e no servidor standalone em Go (`main.go`, `padstore.go`).
  - O tema caderno inicialmente era só um cartão pequeno, centrado, com uma secretária escura à volta — corrigido para preencher a janela toda (tal como o tema normal), mantendo a espiral, o papel pautado e a sombra.
  - Um bug de ordem de pintura CSS fazia a espiral aparecer como uma barra escura sólida em vez de círculos — resolvido dando um fundo próprio à área de padding do `main`.
  - Tamanhos e cores ajustados para bater certo com o mockup: logótipo maior, seta "Ir →", botões Password/Limpar pad com as cores de carimbo do mockup (não o azul da app), faixa de ficheiros com o botão de upload integrado.
- Os separadores da app desktop (uma janela Electron à parte da página de cada separador) foram sincronizados com o easter egg: cada separador avisa a janela principal do seu tema via `ipc-message`, e a barra de separadores (⚙ + abas) muda para o visual de post-its sempre que o separador ativo estiver no modo caderno, voltando ao escuro normal nos separadores que continuam no tema sóbrio.

## Downloads na landing, legibilidade do tema caderno, e correções

- **Página raiz "/"**: por baixo do formulário "Abrir pad", nova secção com dois grupos — Cliente (app desktop) e Servidor (binário standalone) — cada um com 4 ícones (Windows, Linux, macOS, GitHub), logótipos originais em SVG inline (não emoji). Os links são resolvidos em tempo real pela API do GitHub (`releases/latest`), por isso nunca ficam presos a uma versão à medida que saem releases novas; sem JS ou se a API falhar (ex.: repositório ainda privado), caem de volta para a página de releases em vez de um link morto. macOS assume Apple Silicon por omissão, com um link "Intel" por baixo. Foi preciso abrir `connect-src` do CSP para `api.github.com`, em paralelo no servidor Node (`server/middleware/security.js`) e no standalone em Go (`standalone/security.go`).
- **Logótipo "sebinta" maior no tema sóbrio** — `1.05rem→1.4rem`, ícone `22px→28px`.
- **Tema caderno bem mais legível** — não só o nome do pad e o estado "em direto" (que estavam pequenos e em contraste fraco), mas também os botões de ação, o cabeçalho "FICHEIROS", o botão de upload, o aviso de arrastar ficheiros, e o nome/tamanho dos cartões de ficheiro. A barra de progresso "a enviar…" nem tinha estilo de papel — ficava a caixa escura da UI base a flutuar sobre o papel; agora tem o mesmo aspeto de post-it tracejado das outras secções. Nas tabs da app desktop, letra maior (`1rem→1.3rem`) quando o separador ativo está no tema caderno.
- **Botão "✕" das tabs do desktop** encostado sempre à borda direita da tab (`flex:1 1 auto` no nome), em vez de logo a seguir ao nome — antes, em nomes curtos, ficava colado ao texto com espaço morto até à borda.
- **Corrigido um bug de CSP**: o script inline no `<head>` do `pad.html` que aplicava o tema caderno guardado no `localStorage` estava a ser bloqueado por `script-src 'self'` — o tema nunca sobrevivia a um reload, só ficava ativo até se clicar de novo no logótipo. Movido para `public/js/theme-init.js` (ficheiro externo, mesma posição logo após `<body>`, sem flash do tema errado).
- **README simplificado e em inglês** — o README principal passou de ~235 para menos de 80 linhas; a walkthrough do túnel Cloudflare, referência de configuração, operações Docker, backup/restore e troubleshooting mudaram-se para `docs/DEPLOYMENT.md`. Screenshot da landing atualizado para mostrar a nova secção de downloads.

## Releases publicadas

| Versão | Destaques |
|---|---|
| `v1.4.0` | Rebrand completo para Sebinta |
| `v1.5.0` | Logótipo centrado + easter egg do tema caderno (primeira versão) |
| `v1.6.0` | Nomes dos binários passam a incluir a versão; correções de fidelidade do tema caderno |
| `v1.7.0` | Tema caderno a ocupar o ecrã todo; separadores do desktop sincronizados com o tema |
| `v1.8.0` | Downloads (Cliente/Servidor) na landing; tema caderno mais legível; fix do "✕" das tabs; fix de CSP no tema; README simplificado |

Cada release inclui: servidor standalone em Go (`sebinta-server-vX.Y.Z-*`, 4 plataformas), CLI de limpeza de metadados (`sebinta-clean-vX.Y.Z-*`, 4 plataformas) e app desktop Electron (`Sebinta-desktop-vX.Y.Z-*`: AppImage, `.exe` portátil, `.zip` macOS x64/arm64), mais um `SHA256SUMS.txt`.

## Problemas reportados e resolvidos hoje

- **"A versão Linux não abre"**: não era bug — o binário standalone tinha mesmo arrancado com sucesso à primeira tentativa e ficou a correr em segundo plano (sem terminal visível); as tentativas seguintes falhavam com "porta já em uso" por essa razão. Documentado o passo em falta (`chmod +x`, perdido no download) no README principal, no `standalone/README.md`, e nas notas da release `v1.7.0`.
- **AppImage da app desktop**: falhava com `dlopen(): error loading libfuse.so.2` em distros que já não trazem `libfuse2` por omissão (Kali, Debian/Ubuntu 22.04+, Fedora, entre outras — o runtime por omissão do AppImage precisa da lib de compatibilidade FUSE2, não FUSE3). Confirmado que `./Sebinta-*.AppImage --appimage-extract-and-run` resolve sem precisar de root. Documentado no `desktop/README.md` e nas notas da release `v1.7.0`.
