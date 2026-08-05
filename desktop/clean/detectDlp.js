'use strict';

/*
 * Deteção rápida de tags de classificação/DLP num documento Office OOXML,
 * sem descomprimir nada (só lista os nomes das entradas do ZIP) — usada
 * para decidir se a limpeza deve ser forçada mesmo com o toggle do
 * utilizador desligado. Ver desktop/clean/office.js para a limpeza em si.
 */

const fflate = require('fflate');

/**
 * @param {Buffer} inputBuffer conteúdo do ficheiro .docx/.xlsx/.pptx
 * @returns {boolean} true se o pacote contiver a pasta customXml/ (Titus/Purview/etc.)
 */
function hasDlpTags(inputBuffer) {
  let found = false;
  try {
    fflate.unzipSync(new Uint8Array(inputBuffer), {
      filter(file) {
        if (file.name.startsWith('customXml/')) found = true;
        return false; // nunca descomprime — só precisamos dos nomes
      },
    });
  } catch (e) {
    return false; // ficheiro inválido: deixa cleanOoxml() reportar o erro a sério
  }
  return found;
}

module.exports = { hasDlpTags };
