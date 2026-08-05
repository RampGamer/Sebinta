'use strict';

/*
 * Limpeza de metadados de ficheiros Office OOXML (.docx/.xlsx/.pptx) no
 * browser. Estes ficheiros são arquivos ZIP; usa-se fflate (carregada via
 * importScripts em worker.js, expõe o global fflate) para os abrir,
 * substituir as partes com metadados por versões vazias, e reempacotar.
 */
self.cleanOffice = async function cleanOffice(buffer, mimeType) {
  let zip;
  try {
    zip = self.fflate.unzipSync(new Uint8Array(buffer));
  } catch (e) {
    throw new Error('Ficheiro Office inválido ou corrompido — não foi possível limpar os metadados.');
  }

  const encoder = new TextEncoder();

  // docProps/core.xml: autor, último autor a gravar, título, assunto,
  // palavras-chave, número de revisão, datas de criação/modificação.
  const emptyCore = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties ' +
    'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>'
  );

  // docProps/app.xml: nome da empresa, gestor, tempo total de edição,
  // aplicação que criou o documento.
  const emptyApp = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>'
  );

  let touchedAnyPart = false;
  if (zip['docProps/core.xml']) { zip['docProps/core.xml'] = emptyCore; touchedAnyPart = true; }
  if (zip['docProps/app.xml']) { zip['docProps/app.xml'] = emptyApp; touchedAnyPart = true; }

  // docProps/custom.xml (propriedades personalizadas) e thumbnail: removidos.
  for (const name of Object.keys(zip)) {
    if (name === 'docProps/custom.xml' || /^docProps\/thumbnail\./.test(name)) {
      delete zip[name];
      touchedAnyPart = true;
    }
  }

  // Remove referências pendentes à thumbnail nas relações do pacote, para o
  // documento se manter válido (Word/Excel/PowerPoint não toleram
  // relationships a apontar para ficheiros que já não existem).
  if (zip['_rels/.rels']) {
    try {
      const relsText = new TextDecoder().decode(zip['_rels/.rels']);
      const cleanedRels = relsText.replace(
        /<Relationship[^>]*Target="docProps\/thumbnail[^"]*"[^>]*\/>/g,
        ''
      );
      if (cleanedRels !== relsText) {
        zip['_rels/.rels'] = encoder.encode(cleanedRels);
      }
    } catch (e) {
      // Melhor esforço: se a limpeza das relações falhar, mantém-se o
      // ficheiro original — a ausência da thumbnail já foi tratada acima.
    }
  }

  if (!touchedAnyPart) {
    throw new Error('Este ficheiro não parece ser um documento Office OOXML válido.');
  }

  let repacked;
  try {
    repacked = self.fflate.zipSync(zip, { level: 6 });
  } catch (e) {
    throw new Error('Falha ao reconstruir o documento depois de limpar os metadados.');
  }

  const outBuffer = repacked.buffer.slice(repacked.byteOffset, repacked.byteOffset + repacked.byteLength);
  return { buffer: outBuffer, mimeType };
};
