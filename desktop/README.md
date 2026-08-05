# filepad-desktop

App desktop (Electron) para o Filepad. Abre a mesma interface que verias num
browser normal — mesmo pad, mesmo texto, mesmos ficheiros, sincronização em
tempo real incluída — mas intercepta cada upload para limpar metadados
localmente, **antes** de o ficheiro sair do computador:

- **Office** (`.docx`/`.xlsx`/`.pptx`): remove `docProps/core.xml`,
  `docProps/app.xml`, `docProps/custom.xml`, a thumbnail incorporada, e toda
  a pasta `customXml/` — onde ferramentas de classificação/DLP como Titus ou
  Microsoft Purview guardam etiquetas fora das propriedades habituais do
  Office. Se essas tags forem detetadas, a limpeza é **sempre aplicada**,
  independentemente do toggle.
- **PDF**: limpa o dicionário Info (autor, título, datas…) e a stream de
  metadados XMP.
- Qualquer outro tipo de ficheiro (imagem, vídeo, áudio, Office legado
  `.doc`/`.xls`/`.ppt`) segue sem alteração — tal como a versão web, que não
  limpa nada.

A limpeza em si reutiliza a mesma lógica já validada no CLI Go
(`../cli/officeclean.go`) e na antiga limpeza de PDF do browser, mas corre em
Node puro no processo principal do Electron — fora de qualquer Web Worker —
o que evita as armadilhas (CSP, cache de worker desatualizado) que tornavam
a limpeza no browser pouco fiável.

## Instalar e correr

```bash
cd desktop
npm install
npm start
```

Na primeira vez, a app pede o URL do teu servidor Filepad (o mesmo domínio
do túnel Cloudflare que já usas no browser, ex.:
`https://notas.oteudominio.com`). Fica gravado — a partir daí é só abrir a
app e já está no pad, como abrir o browser. Para mudar de servidor mais
tarde: menu **Filepad → Mudar servidor…**.

## Empacotar (instalador)

```bash
npm run dist
```

Gera instaladores para Linux (AppImage), macOS (dmg) e Windows (nsis) via
`electron-builder` (configuração em `package.json`). Builds cross-platform
completos normalmente precisam de correr no respetivo SO (ou CI); a partir
de Linux só o AppImage é garantido sem mais configuração.
