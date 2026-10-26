/**
 * Does the frame actually show terrain?
 *
 * The chunk counters cannot answer this. On 2026-08-05 the combined private-heap
 * gate reported 329 client chunks and 222 `visRenderable` sections while an early
 * in-game screenshot was "a mostly empty grey/fog plane with floating tree
 * fragments" (docs/HISTORY.md). `visRenderable > 0` is exactly the assertion that
 * passed for that frame, so a pixel test is the only thing that can gate it.
 *
 * The discriminator is local detail, not colour. Minecraft terrain is 16x16 pixel
 * art: every block face carries high-frequency noise. Sky and distance fog are
 * flat. So the fraction of sampled pixels whose neighbour differs by more than a
 * few luma steps separates the two cleanly, and it keeps working across biomes,
 * time of day, and fog colour -- none of which a colour threshold survives.
 *
 * The sample region deliberately excludes the HUD. In the failing frame the
 * hearts, hotbar, and held item were the *only* detail present; including them
 * scores an empty world as textured and defeats the whole gate.
 */

/**
 * Fractions of canvas width/height. Excludes the top-right toast, the bottom
 * centre hearts/hotbar (y > 0.80), and the bottom-right held item (x > 0.66).
 * With the camera pitched down this band is ground in a healthy frame.
 */
export const DEFAULT_REGION = { x0: 0.02, x1: 0.66, y0: 0.50, y1: 0.80 };

/** Luma steps between neighbours before a sample counts as textured. */
export const DEFAULT_GRADIENT = 10;

/**
 * Decodes a PNG and measures detail inside the region.
 *
 * Self-contained on purpose: Playwright stringifies this to run it inside the
 * page, so it may not close over anything at module scope.
 *
 * @param {{pngBase64: string, region: {x0:number,x1:number,y0:number,y1:number},
 *          gradientThreshold: number}} input
 */
export async function analyzeTerrainFrame(input) {
  const { pngBase64, region, gradientThreshold } = input;
  const response = await fetch(`data:image/png;base64,${pngBase64}`);
  const bitmap = await createImageBitmap(await response.blob());
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const x0 = Math.round(width * region.x0);
  const x1 = Math.round(width * region.x1);
  const y0 = Math.round(height * region.y0);
  const y1 = Math.round(height * region.y1);
  const bandWidth = x1 - x0;
  const bandHeight = y1 - y0;
  if (bandWidth < 8 || bandHeight < 8) {
    throw new Error(`sample region too small: ${bandWidth}x${bandHeight}`);
  }
  const { data } = context.getImageData(x0, y0, bandWidth, bandHeight);

  const luma = new Float32Array(bandWidth * bandHeight);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Step 2 so the gradient spans a real texel edge rather than one interpolated
  // pixel, and so a 1280x720 frame stays well under a millisecond.
  const step = 2;
  const histogram = new Uint32Array(256);
  let samples = 0;
  let textured = 0;
  let lumaSum = 0;
  for (let y = 0; y + step < bandHeight; y += step) {
    for (let x = 0; x + step < bandWidth; x += step) {
      const here = luma[y * bandWidth + x];
      const gradient = Math.abs(here - luma[y * bandWidth + x + step])
        + Math.abs(here - luma[(y + step) * bandWidth + x]);
      if (gradient >= gradientThreshold) textured++;
      histogram[Math.min(255, Math.max(0, Math.round(here)))]++;
      lumaSum += here;
      samples++;
    }
  }

  // A fog plane is one colour. Report how much of the band sits within a few
  // luma steps of the most common value: high means flat, whatever the hue.
  let modalLuma = 0;
  for (let i = 1; i < 256; i++) {
    if (histogram[i] > histogram[modalLuma]) modalLuma = i;
  }
  let nearModal = 0;
  for (let i = Math.max(0, modalLuma - 6); i <= Math.min(255, modalLuma + 6); i++) {
    nearModal += histogram[i];
  }

  return {
    width,
    height,
    region: { x0, y0, x1, y1 },
    samples,
    detailFraction: samples ? textured / samples : 0,
    flatFraction: samples ? nearModal / samples : 0,
    meanLuma: samples ? lumaSum / samples : 0,
    modalLuma,
  };
}
