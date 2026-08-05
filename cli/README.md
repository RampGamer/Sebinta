# filepad-clean

Ferramenta de linha de comandos, em Go, para limpar metadados de documentos
Office (`.docx`/`.xlsx`/`.pptx`) **completamente fora do browser**, antes de
qualquer contacto com a rede. Reimplementa em Go puro (sem dependências) a
mesma lógica que já existe em `public/js/metadata/office-clean.js` e
`server/services/officeClean.js`: substitui `docProps/core.xml` e
`docProps/app.xml` por versões vazias, remove `docProps/custom.xml`, a
thumbnail incorporada, e toda a pasta `customXml/` (Custom XML Parts — onde
ferramentas de classificação/DLP como Titus ou Microsoft Purview guardam
etiquetas fora das propriedades habituais do Office), e corrige os
ficheiros `.rels`/`[Content_Types].xml` para o documento continuar a abrir
sem pedir "reparação".

Não lida com `.doc`/`.xls`/`.ppt` legado (formato binário OLE2) — esses
continuam a depender só da limpeza no servidor (`exiftool`), tal como no
browser.

## Compilar

Requer Go 1.21+. A partir desta pasta:

```bash
go build -o filepad-clean .
```

### Binários para os três sistemas operativos (cross-compile)

```bash
GOOS=linux   GOARCH=amd64 go build -o dist/filepad-clean-linux-amd64     .
GOOS=darwin  GOARCH=arm64 go build -o dist/filepad-clean-macos-arm64     .
GOOS=darwin  GOARCH=amd64 go build -o dist/filepad-clean-macos-amd64     .
GOOS=windows GOARCH=amd64 go build -o dist/filepad-clean-windows-amd64.exe .
```

Cada comando produz um binário único, sem dependências de runtime — só
copiar e correr.

## Usar

### Só limpar (nunca toca na rede)

```bash
./filepad-clean clean relatorio.docx
# grava relatorio.clean.docx e lista o que foi removido
```

### Limpar e enviar diretamente para um pad do Filepad

```bash
./filepad-clean send -server https://notas.exemplo.com -pad projeto-x relatorio.docx

# se o site tiver password global:
./filepad-clean send -server https://notas.exemplo.com -pad projeto-x -site-password SENHA relatorio.docx

# se o pad em concreto tiver password própria:
./filepad-clean send -server https://notas.exemplo.com -pad projeto-x -pad-password SENHA relatorio.docx
```

O `send` limpa o ficheiro localmente primeiro (mesma lógica do `clean`), só
depois autentica-se contra o servidor (password do site / do pad, se
aplicável) e faz o upload via `POST /api/files` — o mesmo endpoint que o
browser usa, incluindo o token CSRF de double-submit cookie exigido pela
API.
