'use strict';

/*
 * Limpeza de metadados de ficheiros Office OOXML (.docx/.xlsx/.pptx) no
 * browser — esta é a camada que importa mais para este tipo de ficheiro:
 * corre ANTES de qualquer contacto com o servidor, para os metadados nunca
 * chegarem a sair do computador de origem (ver requisito de segurança #10).
 *
 * Estes ficheiros são arquivos ZIP; usa-se fflate (carregada via
 * importScripts em worker.js, expõe o global fflate) para os abrir,
 * substituir/remover as partes com metadados, e reempacotar.
 *
 * Além de docProps/core.xml, docProps/app.xml, docProps/custom.xml e da
 * thumbnail, remove-se também TODA a pasta customXml/ — é ali que
 * ferramentas empresariais de classificação/DLP (Titus, Microsoft Purview
 * Information Protection, Boldon James, etc.) costumam guardar etiquetas
 * como "TitusGUID" ou "CLASSIFICATION", fora das propriedades habituais do
 * Office. Sem isto, a limpeza ficava incompleta para documentos que passam
 * por essas ferramentas antes de chegarem ao utilizador.
 */

const EMPTY_CORE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<cp:coreProperties ' +
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>';

const EMPTY_APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';

/** Remove entradas <Relationship> cujo Target aponte para uma parte removida. */
function stripRelationships(xmlText, removedPartMatchers) {
  return xmlText.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
    const targetMatch = /Target="([^"]*)"/.exec(tag);
    if (!targetMatch) return tag;
    const target = targetMatch[1];
    return removedPartMatchers.some((re) => re.test(target)) ? '' : tag;
  });
}

/** Remove <Override PartName="..."> cujo PartName aponte para uma parte removida. */
function stripContentTypeOverrides(xmlText, removedPartMatchers) {
  return xmlText.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const partNameMatch = /PartName="([^"]*)"/.exec(tag);
    if (!partNameMatch) return tag;
    const partName = partNameMatch[1];
    return removedPartMatchers.some((re) => re.test(partName)) ? '' : tag;
  });
}

self.cleanOffice = async function cleanOffice(buffer, mimeType) {
  let zip;
  try {
    zip = self.fflate.unzipSync(new Uint8Array(buffer));
  } catch (e) {
    throw new Error('Ficheiro Office inválido ou corrompido — não foi possível limpar os metadados.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  let touchedAnyPart = false;

  // docProps/core.xml: autor, último autor a gravar, título, assunto,
  // palavras-chave, número de revisão, datas de criação/modificação.
  if (zip['docProps/core.xml']) { zip['docProps/core.xml'] = encoder.encode(EMPTY_CORE_XML); touchedAnyPart = true; }
  // docProps/app.xml: nome da empresa, gestor, tempo total de edição,
  // aplicação que criou o documento.
  if (zip['docProps/app.xml']) { zip['docProps/app.xml'] = encoder.encode(EMPTY_APP_XML); touchedAnyPart = true; }

  // docProps/custom.xml (propriedades personalizadas — é frequentemente
  // aqui que ferramentas como o Titus guardam a classificação), thumbnail,
  // e toda a pasta customXml/ (Custom XML Parts).
  const removedPartMatchers = [/customXml\//, /docProps\/thumbnail\./, /docProps\/custom\.xml$/];
  for (const name of Object.keys(zip)) {
    if (name.startsWith('customXml/') || name === 'docProps/custom.xml' || /^docProps\/thumbnail\./.test(name)) {
      delete zip[name];
      touchedAnyPart = true;
    }
  }

  // Corrige todos os ficheiros de relações (root e por-parte, ex.:
  // word/_rels/document.xml.rels) para não apontarem para partes
  // removidas — mantém o pacote válido para o Word/Excel/PowerPoint não
  // pedirem para "reparar" o ficheiro ao abrir.
  for (const name of Object.keys(zip)) {
    if (!name.endsWith('.rels')) continue;
    try {
      const original = decoder.decode(zip[name]);
      const cleaned = stripRelationships(original, removedPartMatchers);
      if (cleaned !== original) zip[name] = encoder.encode(cleaned);
    } catch (e) { /* melhor esforço: mantém o ficheiro de relações original */ }
  }

  if (zip['[Content_Types].xml']) {
    try {
      const original = decoder.decode(zip['[Content_Types].xml']);
      const cleaned = stripContentTypeOverrides(original, removedPartMatchers);
      if (cleaned !== original) zip['[Content_Types].xml'] = encoder.encode(cleaned);
    } catch (e) { /* melhor esforço */ }
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
