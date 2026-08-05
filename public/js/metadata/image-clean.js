'use strict';

/*
 * Limpeza de metadados de imagens (JPEG/PNG/WebP) no browser.
 *
 * Estratégia: descodificar a imagem com createImageBitmap() e voltar a
 * desenhá-la para um OffscreenCanvas, depois reexportar. O canvas só
 * trabalha com pixels — EXIF, GPS, comentários e qualquer outro metadado
 * binário nunca chegam a fazer parte do resultado, porque nunca são lidos
 * pelo decodificador de pixels. `imageOrientation: 'from-image'` aplica a
 * rotação/espelho indicado pela tag EXIF de orientação ANTES da tag ser
 * descartada, para a imagem não ficar rodada incorretamente.
 */
self.cleanImage = async function cleanImage(buffer, mimeType) {
  const blob = new Blob([buffer], { type: mimeType });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error('Não foi possível processar esta imagem (pode estar corrompida).');
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('O browser não suporta a limpeza de imagens necessária.');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const outType = mimeType === 'image/png' ? 'image/png'
    : mimeType === 'image/webp' ? 'image/webp'
    : 'image/jpeg';

  const outBlob = await canvas.convertToBlob({ type: outType, quality: 0.92 });
  const outBuffer = await outBlob.arrayBuffer();
  return { buffer: outBuffer, mimeType: outType };
};
