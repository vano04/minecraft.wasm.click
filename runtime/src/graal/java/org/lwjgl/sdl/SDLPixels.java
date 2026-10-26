package org.lwjgl.sdl;

import org.lwjgl.system.MemoryUtil;

/** Browser SDL: the one pixel format the browser display reports. */
public final class SDLPixels {
    public static final int SDL_PIXELFORMAT_XRGB8888 = 370546692;

    /** SDL owns the details it returns; one static copy is enough for one format. */
    private static SDL_PixelFormatDetails xrgb8888;

    private SDLPixels() {
    }

    public static synchronized SDL_PixelFormatDetails SDL_GetPixelFormatDetails(int format) {
        if (format != SDL_PIXELFORMAT_XRGB8888) {
            SDLError.fail("unsupported pixel format " + format);
            return null;
        }
        if (xrgb8888 == null) {
            long address = MemoryUtil.nmemCallocChecked(1, SDL_PixelFormatDetails.SIZEOF);
            MemoryUtil.memPutInt(address + SDL_PixelFormatDetails.FORMAT, format);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.BITS_PER_PIXEL, (byte) 24);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.BYTES_PER_PIXEL, (byte) 4);
            MemoryUtil.memPutInt(address + SDL_PixelFormatDetails.RMASK, 0x00FF0000);
            MemoryUtil.memPutInt(address + SDL_PixelFormatDetails.GMASK, 0x0000FF00);
            MemoryUtil.memPutInt(address + SDL_PixelFormatDetails.BMASK, 0x000000FF);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.RBITS, (byte) 8);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.GBITS, (byte) 8);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.BBITS, (byte) 8);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.RSHIFT, (byte) 16);
            MemoryUtil.memPutByte(address + SDL_PixelFormatDetails.GSHIFT, (byte) 8);
            xrgb8888 = SDL_PixelFormatDetails.create(address);
        }
        return xrgb8888;
    }
}
