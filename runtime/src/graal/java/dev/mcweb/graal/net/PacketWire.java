package dev.mcweb.graal.net;

import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import net.minecraft.network.ProtocolInfo;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.Packet;

/**
 * Encodes a packet with Mojang's own protocol codec, over a plain heap buffer.
 * BrowserSocketPump uses it to read the play phase's keep-alive ids for the
 * gateway: encoding the packet is correct on any protocol version, where a
 * hard-coded id would not be.
 */
public final class PacketWire {
    private PacketWire() {
    }

    /**
     * Encodes one already-unbundled packet.
     *
     * <p>Bundles must be split by {@link net.minecraft.network.protocol.BundlerInfo}
     * before reaching this method, exactly as vanilla's {@code PacketBundlePacker}
     * does ahead of its encoder: a {@code BundlePacket} has no wire form of its
     * own, only a delimiter around its children.</p>
     */
    public static byte[] encode(final ProtocolInfo<?> protocol, final Packet<?> packet) {
        ByteBuf buffer = Unpooled.buffer();
        try {
            codecOf(protocol).encode(buffer, packet);
            byte[] bytes = new byte[buffer.readableBytes()];
            buffer.readBytes(bytes);
            return bytes;
        } finally {
            buffer.release();
        }
    }

    /**
     * The same unchecked hop Mojang makes in {@code Connection.genericsFtw}: the
     * protocol phase guarantees the packet belongs to this codec, and a mismatch
     * surfaces as a decode failure rather than being preventable by the type
     * system through a {@code ProtocolInfo<?>}.
     */
    @SuppressWarnings("unchecked")
    private static StreamCodec<ByteBuf, Packet<?>> codecOf(final ProtocolInfo<?> protocol) {
        return (StreamCodec<ByteBuf, Packet<?>>) (StreamCodec<ByteBuf, ?>) protocol.codec();
    }
}
