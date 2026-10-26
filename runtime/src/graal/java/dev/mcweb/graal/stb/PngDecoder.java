package dev.mcweb.graal.stb;

import java.io.IOException;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * PNG decoder standing in for STB's in the browser. LWJGL's STBImage is a
 * native library, which cannot exist for wasm, so this port's own
 * {@code org.lwjgl.stb.STBImage} sits ahead of the lwjgl-stb jar on the
 * classpath and routes {@code stbi_load_from_memory} -- which is what
 * {@code NativeImage.read} calls for every texture -- here. Covers what
 * Minecraft's assets use: bit depth 8 (and 1/2/4 for grayscale and paletted
 * images), color types grayscale/RGB/palette/gray+alpha/RGBA, non-interlaced.
 * Output is always 8-bit, matching the stbi_load (non-HDR, non-16) entry points.
 *
 * <p>Boot decodes ~4000 of these on the texture-loading workers, so the work per
 * byte matters: the IDAT stream is inflated by the runtime's zlib straight into
 * the one buffer that is then unfiltered in place, and each color type is
 * expanded by its own loop over lookup tables rather than a per-pixel switch.</p>
 */
public final class PngDecoder {
    public record Decoded(int width, int height, int comp, byte[] pixels) {
    }

    private static final byte[] SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};

    // Chunk types as their big-endian ASCII, compared without making a String per chunk.
    private static final int IHDR = 0x49484452;
    private static final int PLTE = 0x504C5445;
    private static final int TRNS = 0x74524E53;
    private static final int IDAT = 0x49444154;
    private static final int IEND = 0x49454E44;

    /**
     * One inflater per decoding thread, reset after each image. The OpenJDK
     * runtime's own zlib (the one that reads every jar) does the inflating: on
     * the wasm JVM that is compiled C, where the pure-Java DEFLATE this
     * replaced spent 42% of the texture workers' boot samples in its bit
     * reader. An Inflater owns native zlib state and a Cleaner registration,
     * and the same few workers decode thousands of images, so each keeps one.
     */
    private static final ThreadLocal<Inflater> INFLATER = ThreadLocal.withInitial(Inflater::new);

    private PngDecoder() {
    }

    /**
     * Decode a PNG, converting to {@code desiredChannels} components per pixel
     * (0 keeps the file's native count; 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA).
     */
    public static Decoded decode(byte[] data, int desiredChannels) throws IOException {
        if (data.length < SIGNATURE.length) {
            throw new IOException("PNG data is truncated");
        }
        for (int i = 0; i < SIGNATURE.length; i++) {
            if (data[i] != SIGNATURE[i]) {
                throw new IOException("not a PNG image");
            }
        }

        int width = 0;
        int height = 0;
        int bitDepth = 0;
        int colorType = 0;
        int interlace = 0;
        byte[] palette = null;
        byte[] transparency = null;
        // IDAT payloads as (offset, length) pairs into data: the inflater reads
        // them where they are instead of from a concatenated copy.
        int[] idat = new int[2];
        int idatCount = 0;

        int pos = SIGNATURE.length;
        boolean finished = false;
        while (!finished) {
            if (pos + 12 > data.length) {
                throw new IOException("PNG chunk header overruns the data");
            }
            int length = readInt(data, pos);
            int type = readInt(data, pos + 4);
            int payload = pos + 8;
            if (length < 0 || payload + length + 4 > data.length) {
                throw new IOException("PNG chunk '" + chunkName(type) + "' overruns the data");
            }
            switch (type) {
                case IHDR -> {
                    width = readInt(data, payload);
                    height = readInt(data, payload + 4);
                    bitDepth = data[payload + 8] & 0xFF;
                    colorType = data[payload + 9] & 0xFF;
                    int compression = data[payload + 10] & 0xFF;
                    int filter = data[payload + 11] & 0xFF;
                    interlace = data[payload + 12] & 0xFF;
                    if (width <= 0 || height <= 0) {
                        throw new IOException("invalid PNG dimensions " + width + "x" + height);
                    }
                    if (compression != 0 || filter != 0) {
                        throw new IOException("unsupported PNG compression/filter method");
                    }
                }
                case PLTE -> palette = slice(data, payload, length);
                case TRNS -> transparency = slice(data, payload, length);
                case IDAT -> {
                    if (idatCount * 2 == idat.length) {
                        idat = java.util.Arrays.copyOf(idat, idat.length * 2);
                    }
                    idat[idatCount * 2] = payload;
                    idat[idatCount * 2 + 1] = length;
                    idatCount++;
                }
                case IEND -> finished = true;
                default -> {
                    // ancillary chunk; skip
                }
            }
            pos = payload + length + 4;
        }
        if (width == 0 || bitDepth == 0) {
            throw new IOException("PNG is missing its IHDR chunk");
        }
        if (interlace != 0) {
            throw new IOException("interlaced PNGs are not supported");
        }

        int channels = switch (colorType) {
            case 0 -> 1;
            case 2 -> 3;
            case 3 -> 1; // palette index; expanded through PLTE below
            case 4 -> 2;
            case 6 -> 4;
            default -> throw new IOException("unsupported PNG color type " + colorType);
        };
        boolean paletted = colorType == 3;
        if (paletted && palette == null) {
            throw new IOException("paletted PNG is missing its PLTE chunk");
        }
        // PNG allows 1/2/4-bit samples for grayscale as well as palette, and
        // the vanilla assets use both: 12 of the 3855 textures in the 26.2 jar
        // are sub-byte grayscale. Rejecting them is not a cosmetic loss --
        // TextureAtlas stitches every sprite in one pass, so a single sprite
        // that fails to decode aborts the whole atlas, which is then never
        // uploaded. That is what made terrain, the sun and moon, and the
        // atlas-sourced GUI sprites all invisible while standalone textures
        // (panorama, logo, skins) rendered normally.
        boolean subByteCapable = paletted || colorType == 0;
        if (bitDepth != 8 && !(subByteCapable && (bitDepth == 1 || bitDepth == 2 || bitDepth == 4))) {
            throw new IOException("unsupported PNG bit depth " + bitDepth
                    + " for color type " + colorType);
        }

        long strideLong = ((long) bitDepth * channels * width + 7) / 8;
        long rawLength = (strideLong + 1) * height; // +1 filter byte per row
        long rgbaLength = (long) width * height * 4;
        if (rawLength > Integer.MAX_VALUE || rgbaLength > Integer.MAX_VALUE) {
            throw new IOException("PNG image is too large");
        }
        int stride = (int) strideLong;
        int bytesPerPixel = Math.max(1, bitDepth * channels / 8);

        byte[] raw = new byte[(int) rawLength];
        inflate(data, idat, idatCount, raw);

        byte[] rgba = new byte[(int) rgbaLength];
        if (colorType == 6) {
            // Already RGBA8: unfilter each row from the inflated stream straight
            // into its place in the output, dropping the filter bytes on the way.
            for (int y = 0; y < height; y++) {
                int in = y * (stride + 1);
                int out = y * stride;
                unfilterRow(raw[in] & 0xFF, raw, in + 1, rgba, out, y == 0 ? -1 : out - stride,
                        stride, bytesPerPixel);
            }
        } else {
            for (int y = 0; y < height; y++) {
                int in = y * (stride + 1);
                unfilterRow(raw[in] & 0xFF, raw, in + 1, raw, in + 1, y == 0 ? -1 : in - stride,
                        stride, bytesPerPixel);
            }
            expand(raw, stride, width, height, bitDepth, colorType, palette, transparency, rgba);
        }

        int outChannels = desiredChannels == 0 ? 4 : desiredChannels;
        if (outChannels < 1 || outChannels > 4) {
            throw new IOException("unsupported desired channel count " + desiredChannels);
        }
        byte[] pixels;
        if (outChannels == 4) {
            pixels = rgba;
        } else {
            pixels = new byte[width * height * outChannels];
            for (int i = 0, j = 0; i < pixels.length; i += outChannels, j += 4) {
                int r = rgba[j] & 0xFF;
                int g = rgba[j + 1] & 0xFF;
                int b = rgba[j + 2] & 0xFF;
                int a = rgba[j + 3] & 0xFF;
                if (outChannels == 1) {
                    pixels[i] = (byte) ((r * 77 + g * 150 + b * 29) >> 8);
                } else if (outChannels == 2) {
                    pixels[i] = (byte) ((r * 77 + g * 150 + b * 29) >> 8);
                    pixels[i + 1] = (byte) a;
                } else {
                    pixels[i] = (byte) r;
                    pixels[i + 1] = (byte) g;
                    pixels[i + 2] = (byte) b;
                }
            }
        }
        // Self-consistency probe. A texture upload that fails with "Copy would
        // overrun the source buffer" means some buffer is shorter than the
        // dimensions it is being used with; this says whether the decoder is
        // the one disagreeing with itself, or whether it produced exactly what
        // it declared and the mismatch is downstream.
        if (pixels.length != width * height * outChannels) {
            report("png:size-mismatch " + width + "x" + height
                    + " comp=" + outChannels + " pixels=" + pixels.length
                    + " expected=" + (width * height * outChannels)
                    + " colorType=" + colorType + " bitDepth=" + bitDepth);
        } else if (decodeReports < 60) {
            decodeReports++;
            report("png:decoded " + width + "x" + height + " comp=" + outChannels
                    + " bytes=" + pixels.length + " colorType=" + colorType
                    + " bitDepth=" + bitDepth + " desired=" + desiredChannels);
        }
        return new Decoded(width, height, outChannels, pixels);
    }

    private static int decodeReports;

    private static void report(String message) {
        try {
            dev.mcweb.graal.webgpu.BrowserGpu.reportProgress(message);
        } catch (Throwable ignored) {
            // Decoding must not depend on the diagnostic channel existing.
        }
    }

    /** Read metadata without producing pixels (stbi_info_from_memory). */
    public static Decoded info(byte[] data) throws IOException {
        Decoded decoded = decode(data, 4);
        return decoded;
    }

    /**
     * Inflate the zlib stream (RFC 1950) spread over the IDAT chunks until
     * {@code raw} is full. Stopping there rather than at the end of the stream
     * means the trailing Adler-32 is not insisted on, as the decoder this
     * replaced never checked it either.
     */
    private static void inflate(byte[] data, int[] idat, int idatCount, byte[] raw) throws IOException {
        Inflater inflater = INFLATER.get();
        int filled = 0;
        try {
            int next = 0;
            while (filled < raw.length) {
                int produced = inflater.inflate(raw, filled, raw.length - filled);
                filled += produced;
                if (produced == 0) {
                    if (inflater.finished() || inflater.needsDictionary()
                            || !inflater.needsInput() || next == idatCount) {
                        break;
                    }
                    inflater.setInput(data, idat[next * 2], idat[next * 2 + 1]);
                    next++;
                }
            }
        } catch (DataFormatException failure) {
            throw new IOException("PNG zlib stream is corrupt: " + failure.getMessage(), failure);
        } finally {
            // Also drops the reference to this image's bytes.
            inflater.reset();
        }
        if (filled < raw.length) {
            throw new IOException("PNG pixel stream is truncated ("
                    + filled + " of " + raw.length + " bytes)");
        }
    }

    /**
     * Reverse one row's PNG filter, reading {@code length} filtered bytes at
     * {@code src[in]} and writing them at {@code dst[out]}; the two may be the
     * same place. {@code prev} is where the previous, already unfiltered row
     * starts in {@code dst}, or -1 for the first row (whose "up" bytes are 0).
     * Each filter is its own loop so the per-byte work has no filter switch and
     * no edge tests: the first {@code bpp} bytes, which have no left neighbour,
     * are peeled off.
     */
    private static void unfilterRow(int filter, byte[] src, int in, byte[] dst, int out, int prev,
                                    int length, int bpp) throws IOException {
        int head = Math.min(bpp, length);
        switch (filter) {
            case 0 -> {
                if (src != dst || in != out) {
                    System.arraycopy(src, in, dst, out, length);
                }
            }
            case 1 -> subRow(src, in, dst, out, length, head, bpp);
            case 2 -> {
                if (prev < 0) {
                    if (src != dst || in != out) {
                        System.arraycopy(src, in, dst, out, length);
                    }
                } else {
                    for (int i = 0; i < length; i++) {
                        dst[out + i] = (byte) (src[in + i] + dst[prev + i]);
                    }
                }
            }
            case 3 -> {
                if (prev < 0) {
                    for (int i = 0; i < head; i++) {
                        dst[out + i] = src[in + i];
                    }
                    for (int i = head; i < length; i++) {
                        dst[out + i] = (byte) (src[in + i] + ((dst[out + i - bpp] & 0xFF) >> 1));
                    }
                } else {
                    for (int i = 0; i < head; i++) {
                        dst[out + i] = (byte) (src[in + i] + ((dst[prev + i] & 0xFF) >> 1));
                    }
                    for (int i = head; i < length; i++) {
                        int left = dst[out + i - bpp] & 0xFF;
                        int up = dst[prev + i] & 0xFF;
                        dst[out + i] = (byte) (src[in + i] + ((left + up) >> 1));
                    }
                }
            }
            case 4 -> {
                if (prev < 0) {
                    // With no row above, Paeth always predicts the left byte.
                    subRow(src, in, dst, out, length, head, bpp);
                } else {
                    // ...and with no byte to the left, the one above.
                    for (int i = 0; i < head; i++) {
                        dst[out + i] = (byte) (src[in + i] + dst[prev + i]);
                    }
                    for (int i = head; i < length; i++) {
                        int a = dst[out + i - bpp] & 0xFF;
                        int b = dst[prev + i] & 0xFF;
                        int c = dst[prev + i - bpp] & 0xFF;
                        int pa = Math.abs(b - c);
                        int pb = Math.abs(a - c);
                        int pc = Math.abs(a + b - c - c);
                        int predicted = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                        dst[out + i] = (byte) (src[in + i] + predicted);
                    }
                }
            }
            default -> throw new IOException("unsupported PNG filter " + filter);
        }
    }

    private static void subRow(byte[] src, int in, byte[] dst, int out, int length, int head, int bpp) {
        for (int i = 0; i < head; i++) {
            dst[out + i] = src[in + i];
        }
        for (int i = head; i < length; i++) {
            dst[out + i] = (byte) (src[in + i] + dst[out + i - bpp]);
        }
    }

    /**
     * Expand unfiltered rows (each at {@code y * (stride + 1) + 1} in
     * {@code raw}) of every color type but RGBA8 to 8-bit RGBA.
     */
    private static void expand(
            byte[] raw,
            int stride,
            int width,
            int height,
            int bitDepth,
            int colorType,
            byte[] palette,
            byte[] transparency,
            byte[] rgba
    ) throws IOException {
        int dst = 0;
        switch (colorType) {
            case 0, 3 -> {
                // Both are one sample per pixel looked up in a 256-entry RGBA
                // table: the widened gray (keyed transparent by tRNS) or the
                // palette entry (with its tRNS alpha).
                byte[] table = colorType == 0
                        ? grayTable(bitDepth, transparency)
                        : paletteTable(palette, transparency);
                int mask = (1 << bitDepth) - 1;
                for (int y = 0; y < height; y++) {
                    int row = y * (stride + 1) + 1;
                    if (bitDepth == 8) {
                        for (int x = 0; x < width; x++, dst += 4) {
                            int entry = (raw[row + x] & 0xFF) << 2;
                            rgba[dst] = table[entry];
                            rgba[dst + 1] = table[entry + 1];
                            rgba[dst + 2] = table[entry + 2];
                            rgba[dst + 3] = table[entry + 3];
                        }
                    } else {
                        // Sub-byte samples are packed most significant first.
                        for (int x = 0, bit = 0; x < width; x++, bit += bitDepth, dst += 4) {
                            int sample = (raw[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & mask;
                            int entry = sample << 2;
                            rgba[dst] = table[entry];
                            rgba[dst + 1] = table[entry + 1];
                            rgba[dst + 2] = table[entry + 2];
                            rgba[dst + 3] = table[entry + 3];
                        }
                    }
                }
            }
            case 2 -> {
                boolean keyed = transparency != null && transparency.length == 6;
                // tRNS holds 16-bit samples; at bit depth 8 only the low bytes matter.
                byte keyR = keyed ? transparency[1] : 0;
                byte keyG = keyed ? transparency[3] : 0;
                byte keyB = keyed ? transparency[5] : 0;
                for (int y = 0; y < height; y++) {
                    int base = y * (stride + 1) + 1;
                    for (int x = 0; x < width; x++, base += 3, dst += 4) {
                        byte r = raw[base];
                        byte g = raw[base + 1];
                        byte b = raw[base + 2];
                        rgba[dst] = r;
                        rgba[dst + 1] = g;
                        rgba[dst + 2] = b;
                        rgba[dst + 3] = keyed && r == keyR && g == keyG && b == keyB ? 0 : (byte) 255;
                    }
                }
            }
            case 4 -> {
                for (int y = 0; y < height; y++) {
                    int base = y * (stride + 1) + 1;
                    for (int x = 0; x < width; x++, base += 2, dst += 4) {
                        byte gray = raw[base];
                        rgba[dst] = gray;
                        rgba[dst + 1] = gray;
                        rgba[dst + 2] = gray;
                        rgba[dst + 3] = raw[base + 1];
                    }
                }
            }
            default -> throw new IOException("unsupported PNG color type " + colorType);
        }
    }

    /**
     * Grayscale sample to RGBA. Intensities are widened to 0-255 as STB does.
     * The tRNS key is a 16-bit big-endian value in range 0..2^bitdepth-1, so it
     * is compared against the raw sample, not the widened one.
     */
    private static byte[] grayTable(int bitDepth, byte[] transparency) {
        int mask = (1 << bitDepth) - 1;
        int key = transparency != null && transparency.length == 2 ? transparency[1] & 0xFF : -1;
        byte[] table = new byte[256 * 4];
        for (int sample = 0; sample <= mask; sample++) {
            byte gray = (byte) (sample * 255 / mask);
            int entry = sample << 2;
            table[entry] = gray;
            table[entry + 1] = gray;
            table[entry + 2] = gray;
            table[entry + 3] = sample == key ? 0 : (byte) 255;
        }
        return table;
    }

    /**
     * Palette index to RGBA. Indices are used verbatim, never widened: scaling
     * them like gray intensities turns 4-bit index 1 into 17 and picks the
     * wrong colour for hundreds of block textures. An index past the palette
     * takes its last colour, tolerating it like STB does; its alpha still comes
     * from tRNS by the index itself.
     */
    private static byte[] paletteTable(byte[] palette, byte[] transparency) throws IOException {
        int entries = palette.length / 3;
        if (entries == 0) {
            throw new IOException("PNG palette is empty");
        }
        byte[] table = new byte[256 * 4];
        for (int index = 0; index < 256; index++) {
            int color = Math.min(index, entries - 1) * 3;
            int entry = index << 2;
            table[entry] = palette[color];
            table[entry + 1] = palette[color + 1];
            table[entry + 2] = palette[color + 2];
            table[entry + 3] = transparency != null && index < transparency.length
                    ? transparency[index]
                    : (byte) 255;
        }
        return table;
    }

    private static String chunkName(int type) {
        return new String(new char[] {
                (char) ((type >>> 24) & 0xFF), (char) ((type >>> 16) & 0xFF),
                (char) ((type >>> 8) & 0xFF), (char) (type & 0xFF)});
    }

    private static int readInt(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }

    private static byte[] slice(byte[] data, int offset, int length) {
        byte[] result = new byte[length];
        System.arraycopy(data, offset, result, 0, length);
        return result;
    }
}
