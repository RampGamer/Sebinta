'use strict';

/*
 * Limpeza de metadados Office OOXML (.docx/.xlsx/.pptx), portada para Node
 * puro (processo principal do Electron, fora de qualquer Worker/CSP de
 * página). Espelha a lógica já validada em cli/officeclean.go e na antiga
 * public/js/metadata/office-clean.js: substitui docProps/core.xml e
 * docProps/app.xml por versões vazias, remove docProps/custom.xml, a
 * thumbnail incorporada, e toda a pasta customXml/ (Custom XML Parts — onde
 * ferramentas de classificação/DLP como Titus ou Microsoft Purview guardam
 * etiquetas fora das propriedades habituais do Office).
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

const REMOVED_PART_MATCHERS = [/customXml\//, /docProps\/thumbnail\./, /docProps\/custom\.xml$/];

function stripRelationships(xmlText) {
  return xmlText.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
    const m = /Target="([^"]*)"/.exec(tag);
    if (!m) return tag;
    return REMOVED_PART_MATCHERS.some((re) => re.test(m[1])) ? '' : tag;
  });
}

function stripContentTypeOverrides(xmlText) {
  return xmlText.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const m = /PartName="([^"]*)"/.exec(tag);
    if (!m) return tag;
    return REMOVED_PART_MATCHERS.some((re) => re.test(m[1])) ? '' : tag;
  });
}

/**
 * @param {Buffer} inputBuffer conteúdo do ficheiro .docx/.xlsx/.pptx
 * @returns {{buffer: Buffer, removed: string[]}} conteúdo limpo e lista legível do que foi removido
 * @throws {Error} se o ficheiro não for um pacote OOXML válido
 */
function cleanOoxml(inputBuffer) {
  let zip;
  try {
    zip = fflate.unzipSync(new Uint8Array(inputBuffer));
  } catch (e) {
    throw new Error('Ficheiro Office inválido ou corrompido — não foi possível limpar os metadados.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const removed = [];
  let touchedAnyPart = false;

  if (zip['docProps/core.xml']) {
    removed.push('Propriedades principais (autor, título, datas de criação/edição) — docProps/core.xml');
    zip['docProps/core.xml'] = encoder.encode(EMPTY_CORE_XML);
    touchedAnyPart = true;
  }
  if (zip['docProps/app.xml']) {
    removed.push('Propriedades da aplicação (empresa, gestor, tempo de edição) — docProps/app.xml');
    zip['docProps/app.xml'] = encoder.encode(EMPTY_APP_XML);
    touchedAnyPart = true;
  }

  let customXmlCount = 0;
  let hasCustomProps = false;
  let hasThumbnail = false;
  for (const name of Object.keys(zip)) {
    if (name.startsWith('customXml/')) { customXmlCount++; delete zip[name]; touchedAnyPart = true; }
    else if (name === 'docProps/custom.xml') { hasCustomProps = true; delete zip[name]; touchedAnyPart = true; }
    else if (/^docProps\/thumbnail\./.test(name)) { hasThumbnail = true; delete zip[name]; touchedAnyPart = true; }
  }
  if (hasCustomProps) removed.push('Propriedades personalizadas — docProps/custom.xml');
  if (hasThumbnail) removed.push('Miniatura incorporada no documento');
  if (customXmlCount > 0) removed.push(`Custom XML Parts — etiquetas de classificação/DLP (${customXmlCount} ficheiro(s))`);

  for (const name of Object.keys(zip)) {
    if (!name.endsWith('.rels')) continue;
    const original = decoder.decode(zip[name]);
    const cleaned = stripRelationships(original);
    if (cleaned !== original) zip[name] = encoder.encode(cleaned);
  }
  if (zip['[Content_Types].xml']) {
    const original = decoder.decode(zip['[Content_Types].xml']);
    const cleaned = stripContentTypeOverrides(original);
    if (cleaned !== original) zip['[Content_Types].xml'] = encoder.encode(cleaned);
  }

  if (!touchedAnyPart) {
    throw new Error('Este ficheiro não parece ser um documento Office OOXML válido.');
  }

  let repacked;
  try {
    repacked = fflate.zipSync(zip, { level: 6 });
  } catch (e) {
    throw new Error('Falha ao reconstruir o documento depois de limpar os metadados.');
  }
  return { buffer: Buffer.from(repacked), removed };
}

module.exports = { cleanOoxml };
