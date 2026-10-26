package dev.mcweb.graal.net;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.UnaryOperator;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.core.RegistryAccess;
import net.minecraft.network.Connection;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.protocol.common.ClientboundKeepAlivePacket;
import net.minecraft.network.protocol.common.ServerboundKeepAlivePacket;
import net.minecraft.network.protocol.game.GameProtocols;
import org.graalvm.webimage.api.JS;

/**
 * Carries every {@link WebSocketChannel}'s socket traffic between Java and the
 * page's {@code mcWebNet} (web/mc-net.js), in one call per frame.
 *
 * <p>Netty's IO thread cannot call the page: the page's objects are reached
 * through an RPC proxy that exists only on the client thread. So channels queue
 * their operations here, and {@link #pump()} - run by the frame pump on the
 * client thread - sends them in order, then hands each channel its socket's
 * state and the packets that arrived. Nothing crosses while no socket exists.
 * A packet waits at most a frame in each direction.</p>
 */
public final class BrowserSocketPump {
    private static final AtomicInteger IDS = new AtomicInteger();
    private static final Map<Integer, Channel> LIVE = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<JsonObject> OPS = new ConcurrentLinkedQueue<>();

    /** The page call; a host-JVM harness puts its own WebSocket client here. */
    public static volatile UnaryOperator<String> exchange = BrowserSocketPump::pageExchange;

    private BrowserSocketPump() {
    }

    /** One live socket, as the client thread sees it. */
    private static final class Channel {
        final WebSocketChannel channel;
        boolean open;
        boolean keepAlivePublished;

        Channel(WebSocketChannel channel) {
            this.channel = channel;
        }
    }

    static int nextSocketId() {
        return IDS.incrementAndGet();
    }

    static void open(WebSocketChannel channel, String host, int port) {
        LIVE.put(channel.socketId, new Channel(channel));
        JsonObject op = op("open", channel.socketId);
        op.addProperty("host", host);
        op.addProperty("port", port);
        OPS.add(op);
    }

    static void send(int id, byte[] body) {
        JsonObject op = op("send", id);
        op.addProperty("data", Base64.getEncoder().encodeToString(body));
        OPS.add(op);
    }

    static void close(int id) {
        if (LIVE.remove(id) != null) {
            OPS.add(op("close", id));
        }
    }

    private static JsonObject op(String kind, int id) {
        JsonObject op = new JsonObject();
        op.addProperty("op", kind);
        op.addProperty("id", id);
        return op;
    }

    /** Client thread, once per frame. */
    public static void pump() {
        if (LIVE.isEmpty() && OPS.isEmpty()) {
            return;
        }
        for (Channel live : LIVE.values()) {
            if (live.open && !live.keepAlivePublished) {
                publishKeepAlive(live);
            }
        }
        JsonArray ops = new JsonArray();
        for (JsonObject op; (op = OPS.poll()) != null; ) {
            ops.add(op);
        }
        JsonObject request = new JsonObject();
        request.add("ops", ops);
        String response = exchange.apply(request.toString());
        if (response == null || response.isEmpty()) {
            return;
        }
        JsonObject sockets = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("sockets");
        for (Map.Entry<String, JsonElement> entry : sockets.entrySet()) {
            Channel live = LIVE.get(Integer.parseInt(entry.getKey()));
            if (live == null) {
                continue;   // closed from Java since this frame's request
            }
            JsonObject socket = entry.getValue().getAsJsonObject();
            String state = socket.get("state").getAsString();
            if (!live.open && state.equals("open")) {
                live.open = true;
                live.channel.opened();
            }
            if (socket.has("in")) {
                live.channel.received(unpack(Base64.getDecoder().decode(socket.get("in").getAsString())));
            }
            if (state.equals("closed") || state.equals("error")) {
                LIVE.remove(live.channel.socketId);
                live.channel.ended(socket.has("error") ? socket.get("error").getAsString() : null);
            }
        }
    }

    private static List<byte[]> unpack(byte[] blob) {
        List<byte[]> bodies = new ArrayList<>();
        for (int at = 0; at + 4 <= blob.length; ) {
            int length = ((blob[at] & 0xff) << 24) | ((blob[at + 1] & 0xff) << 16)
                    | ((blob[at + 2] & 0xff) << 8) | (blob[at + 3] & 0xff);
            at += 4;
            if (length < 0 || at + length > blob.length) {
                break;
            }
            bodies.add(java.util.Arrays.copyOfRange(blob, at, at + length));
            at += length;
        }
        return bodies;
    }

    /**
     * Gives the gateway the play phase's keep-alive ids once the connection is
     * in play. Applying a large server resource pack blocks the client thread
     * for tens of seconds; the gateway, still running, answers keep-alives for
     * it meanwhile, and only this side knows the ids. Encoding the packets
     * with the protocol in use reads them without hard-coding a number.
     */
    private static void publishKeepAlive(Channel live) {
        Object handler = live.channel.pipeline().get("packet_handler");
        if (!(handler instanceof Connection connection)
                || !(connection.getPacketListener() instanceof ClientPacketListener listener)) {
            return;
        }
        live.keepAlivePublished = true;
        try {
            RegistryAccess registries = listener.registryAccess();
            byte[] clientbound = PacketWire.encode(
                    GameProtocols.CLIENTBOUND_TEMPLATE.bind(RegistryFriendlyByteBuf.decorator(registries)),
                    new ClientboundKeepAlivePacket(0L));
            // The context only picks the creative-slot and command-suggestion
            // codecs; a keep-alive encodes the same either way.
            byte[] serverbound = PacketWire.encode(
                    GameProtocols.SERVERBOUND_TEMPLATE.bind(RegistryFriendlyByteBuf.decorator(registries),
                            new GameProtocols.Context() {
                                @Override
                                public boolean hasInfiniteMaterials() {
                                    return false;
                                }

                                @Override
                                public boolean canUseCommandBlocks() {
                                    return false;
                                }
                            }),
                    new ServerboundKeepAlivePacket(0L));
            // A one-byte id and an 8-byte token; anything else needs a wider
            // contract with the gateway, which then just forwards keep-alives.
            if (clientbound.length != 9 || serverbound.length != 9
                    || (clientbound[0] & 0x80) != 0 || (serverbound[0] & 0x80) != 0) {
                return;
            }
            JsonObject op = op("keepAlive", live.channel.socketId);
            op.addProperty("clientbound", clientbound[0] & 0xff);
            op.addProperty("serverbound", serverbound[0] & 0xff);
            op.addProperty("length", 9);
            OPS.add(op);
        } catch (Throwable unavailable) {
            // The gateway keeps forwarding keep-alives; only a long stall suffers.
        }
    }

    @JS.Coerce
    @JS(value = "return globalThis.mcWebNet.exchange(request);", args = {"request"})
    private static native String pageExchange(String request);
}
