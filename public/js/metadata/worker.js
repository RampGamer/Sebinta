'use strict';

/*
 * Web Worker de limpeza de metadados — corre fora da thread principal para
 * a interface não bloquear enquanto um PDF ou documento grande é
 * processado. Só trata os tipos onde a limpeza no browser é viável e
 * exigida (imagem, PDF, Office OOXML); tudo o resto passa direto para o
 * upload e é limpo apenas no servidor (camada de quarentena).
 */
importScripts(
  '/js/vendor/pdf-lib.min.js',
  '/js/vendor/fflate.min.js',
  '/js/metadata/image-clean.js',
  '/js/metadata/pdf-clean.js',
  '/js/metadata/office-clean.js'
);

self.onmessage = async (event) => {
  const { id, kind, buffer, mimeType } = event.data;
  try {
    let result;
    if (kind === 'image') {
      result = await self.cleanImage(buffer, mimeType);
    } else if (kind === 'pdf') {
      result = await self.cleanPdf(buffer);
    } else if (kind === 'ooxml') {
      result = await self.cleanOffice(buffer, mimeType);
    } else {
      throw new Error('Tipo não suportado para limpeza no browser.');
    }
    self.postMessage({ id, ok: true, mimeType: result.mimeType, buffer: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
