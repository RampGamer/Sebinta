'use strict';

/*
 * Limpeza de metadados Office OOXML (.docx/.xlsx/.pptx) no SERVIDOR —
 * camada 2, obrigatória e final (ver server/services/quarantine.js).
 *
 * O exiftool desta imagem NÃO consegue escrever este formato (confirmado:
 * "Writing of DOCX files is not yet supported" — o suporte de escrita OOXML
 * do exiftool depende de versões mais recentes que a disponível no Debian
 * bookworm). Por isso a limpeza server-side destes ficheiros é feita aqui,
 * em Node puro com fflate, em vez de delegada ao exiftool.
 *
 * Espelha (e reforça) a lógica do lado do browser em
 * public/js/metadata/office-clean.js — a diferença mais importante é que
 * esta versão remove também as Custom XML Parts (pasta customXml/), onde
 * ferramentas de classificação/DLP empresariais (Titus, Microsoft Purview
 * Information Protection, Boldon James, etc.) guardam etiquetas como
 * "TitusGUID" ou "CLASSIFICATION" fora do docProps/custom.xml habitual.
 */

const fflate = require('fflate');

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
    const shouldRemove = removedPartMatchers.some((re) => re.test(target));
    return shouldRemove ? '' : tag;
  });
}

/** Remove <Override PartName="..."> cujo PartName aponte para uma parte removida. */
function stripContentTypeOverrides(xmlText, removedPartMatchers) {
  return xmlText.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const partNameMatch = /PartName="([^"]*)"/.exec(tag);
    if (!partNameMatch) return tag;
    const partName = partNameMatch[1];
    const shouldRemove = removedPartMatchers.some((re) => re.test(partName));
    return shouldRemove ? '' : tag;
  });
}

/**
 * @param {Buffer} inputBuffer conteúdo do ficheiro .docx/.xlsx/.pptx
 * @returns {Buffer} conteúdo limpo, pronto a gravar
 * @throws {Error} se o ficheiro não for um pacote OOXML válido
 */
function stripOoxmlMetadata(inputBuffer) {
  let zip;
  try {
    zip = fflate.unzipSync(new Uint8Array(inputBuffer));
  } catch (e) {
    throw new Error('Não é um pacote ZIP/Office válido.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const removedPartMatchers = [/customXml\//, /docProps\/thumbnail\./, /docProps\/custom\.xml$/];

  if (zip['docProps/core.xml']) zip['docProps/core.xml'] = encoder.encode(EMPTY_CORE_XML);
  if (zip['docProps/app.xml']) zip['docProps/app.xml'] = encoder.encode(EMPTY_APP_XML);

  for (const name of Object.keys(zip)) {
    if (name.startsWith('customXml/') || name === 'docProps/custom.xml' || /^docProps\/thumbnail\./.test(name)) {
      delete zip[name];
    }
  }

  // Corrige todos os ficheiros de relações (root e por-parte) para não
  // apontarem para partes removidas — mantém o pacote válido para o Word/
  // Excel/PowerPoint não pedirem para "reparar" o ficheiro ao abrir.
  for (const name of Object.keys(zip)) {
    if (!name.endsWith('.rels')) continue;
    const original = decoder.decode(zip[name]);
    const cleaned = stripRelationships(original, removedPartMatchers);
    if (cleaned !== original) zip[name] = encoder.encode(cleaned);
  }

  if (zip['[Content_Types].xml']) {
    const original = decoder.decode(zip['[Content_Types].xml']);
    const cleaned = stripContentTypeOverrides(original, removedPartMatchers);
    if (cleaned !== original) zip['[Content_Types].xml'] = encoder.encode(cleaned);
  }

  let repacked;
  try {
    repacked = fflate.zipSync(zip, { level: 6 });
  } catch (e) {
    throw new Error('Falha ao reconstruir o ficheiro depois de limpar os metadados.');
  }
  return Buffer.from(repacked);
}

module.exports = { stripOoxmlMetadata };
