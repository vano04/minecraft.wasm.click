import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.authlib.GameProfile;
import dev.mcweb.graal.net.BrowserNet;
import dev.mcweb.graal.net.BrowserSocketPump;
import dev.mcweb.graal.net.PacketWire;
import dev.mcweb.graal.net.WebSocketChannel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelOption;
import io.netty.channel.ConnectTimeoutException;
import io.netty.channel.DefaultEventLoopGroup;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.UnaryOperator;
import java.util.zip.Inflater;
import net.minecraft.SharedConstants;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerStatusPinger;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.Connection;
import net.minecraft.network.ConnectionProtocol;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket;
import net.minecraft.network.protocol.configuration.ClientConfigurationPacketListener;
import net.minecraft.network.protocol.configuration.ConfigurationProtocols;
import net.minecraft.network.protocol.login.ClientLoginPacketListener;
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket;
import net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket;
import net.minecraft.network.protocol.login.LoginProtocols;
import net.minecraft.network.protocol.login.ServerboundHelloPacket;
import net.minecraft.network.protocol.login.ServerboundLoginAcknowledgedPacket;
import net.minecraft.server.Bootstrap;

/**
 * Stage 3 of docs/NET-MIGRATION.md on the host JVM (CLAUDE.md rule 1): Mojang's
 * own Connection and ServerStatusPinger over dev.mcweb.graal.net.WebSocketChannel,
 * through the real gateway (tools/mc-relay.mjs) to OpenJDK/tests/net/mock-mc-server.mjs.
 * The page's mcWebNet.exchange is replaced by a JDK WebSocket client that keeps
 * the same contract (web/mc-net.js header), including the compressed play-phase
 * frames the gateway hands over; BrowserSocketPump.pump runs on a timer thread
 * standing in for the frame pump.
 *
 *   formats   print Mojang's encoding of the packets the mock server sends
 *   link      ping, log in to configuration, and a refused target
 *   lifecycle cancel, timeout, connect and close against a scripted gateway
 *
 * MC-Web test code that calls Mojang's API; it is not shipped and restates none of it.
 */
public class WebSocketLinkProbe {
    static final String GATEWAY = System.getProperty("probe.gateway", "ws://127.0.0.1:25585/");
    static final int PORT = Integer.getInteger("probe.port", 25565);
    static int failures;

    public static void main(String[] args) throws Exception {
        String mode = args.length > 0 ? args[0] : "link";
        if (mode.equals("lifecycle")) {
            lifecycle();
            System.out.println(failures == 0 ? "PROBE PASS" : "PROBE FAIL (" + failures + ")");
            System.exit(failures == 0 ? 0 : 1);
        }
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        if (mode.equals("formats")) {
            formats();
            return;
        }
        BrowserSocketPump.exchange = new JdkExchange();
        Thread pump = new Thread(() -> {
            while (true) {
                try {
                    BrowserSocketPump.pump();
                    Thread.sleep(16);
                } catch (InterruptedException stop) {
                    return;
                } catch (Throwable failure) {
                    System.out.println("pump threw " + failure);
                }
            }
        }, "frame-pump");
        pump.setDaemon(true);
        pump.start();
        ping();
        login("ok");
        login("refuse");
        noServer();
        refusedTarget();
        System.out.println(failures == 0 ? "PROBE PASS" : "PROBE FAIL (" + failures + ")");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void check(boolean ok, String what) {
        System.out.println((ok ? "PASS  " : "FAIL  ") + what);
        if (!ok) failures++;
    }

    /** Exercise the asynchronous channel itself, with a gateway that never connects unless told. */
    static void lifecycle() throws Exception {
        DefaultEventLoopGroup group = new DefaultEventLoopGroup(1);
        UnaryOperator<String> previousExchange = BrowserSocketPump.exchange;
        ScriptedExchange gateway = new ScriptedExchange();
        BrowserSocketPump.exchange = gateway;
        AtomicInteger activations = new AtomicInteger();
        try {
            ChannelFuture cancelled = pendingConnect(group, 0, activations);
            awaitConnecting(cancelled, gateway);
            check(!cancelled.isDone() && gateway.sockets.size() == 1,
                    "the gateway's WebSocket opening does not complete the connect");
            check(cancelled.cancel(true), "ConnectScreen can cancel a pending connect");
            cancelled.channel().closeFuture().awaitUninterruptibly(2000);
            BrowserSocketPump.pump();
            check(cancelled.isCancelled() && !cancelled.channel().isOpen() && activations.get() == 0
                            && gateway.sockets.isEmpty() && gateway.closes == 1,
                    "cancel closes the connecting socket without activating the channel");
            checkIdle(gateway, "cancel removes the socket from the frame pump");

            ChannelFuture timedOut = pendingConnect(group, 80, activations);
            awaitConnecting(timedOut, gateway);
            timedOut.awaitUninterruptibly(2000);
            timedOut.channel().closeFuture().awaitUninterruptibly(2000);
            BrowserSocketPump.pump();
            check(timedOut.cause() instanceof ConnectTimeoutException && !timedOut.channel().isOpen()
                            && gateway.sockets.isEmpty() && gateway.closes == 2 && activations.get() == 0,
                    "the configured connect timeout fails and closes a stalled gateway socket");
            checkIdle(gateway, "timeout removes the socket from the frame pump");

            ChannelFuture connected = pendingConnect(group, 150, activations);
            awaitConnecting(connected, gateway);
            gateway.reply("open", null);
            BrowserSocketPump.pump();
            connected.awaitUninterruptibly(2000);
            // Wait past the old deadline on the same event loop, then inspect
            // the channel: a successful connect must cancel that deadline.
            connected.channel().eventLoop().schedule(() -> { }, 250, TimeUnit.MILLISECONDS).syncUninterruptibly();
            check(connected.isSuccess() && connected.channel().isActive() && activations.get() == 1
                            && gateway.closes == 2,
                    "a connected socket stays active beyond its cancelled connect deadline");
            connected.channel().close().syncUninterruptibly();
            BrowserSocketPump.pump();
            check(gateway.sockets.isEmpty() && gateway.closes == 3, "active close releases the gateway socket once");
            checkIdle(gateway, "active close removes the socket from the frame pump");

            ChannelFuture failed = pendingConnect(group, 150, activations);
            awaitConnecting(failed, gateway);
            gateway.reply("error", "probe: target refused");
            BrowserSocketPump.pump();
            failed.awaitUninterruptibly(2000);
            failed.channel().closeFuture().awaitUninterruptibly(2000);
            failed.channel().eventLoop().schedule(() -> { }, 250, TimeUnit.MILLISECONDS).syncUninterruptibly();
            check(failed.cause() instanceof java.net.ConnectException
                            && failed.cause().getMessage().contains("target refused")
                            && !failed.channel().isOpen() && activations.get() == 1 && gateway.sockets.isEmpty(),
                    "gateway failure preserves its reason and cancels the pending deadline");
            checkIdle(gateway, "gateway failure removes the socket from the frame pump");
        } finally {
            group.shutdownGracefully(0, 2, TimeUnit.SECONDS).syncUninterruptibly();
            BrowserSocketPump.pump();
            BrowserSocketPump.exchange = previousExchange;
        }
    }

    static ChannelFuture pendingConnect(DefaultEventLoopGroup group, int timeoutMillis, AtomicInteger activations) {
        ChannelFuture future = new io.netty.bootstrap.Bootstrap().group(group).channel(WebSocketChannel.class)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, timeoutMillis)
                .handler(new ChannelInboundHandlerAdapter() {
                    @Override
                    public void channelActive(ChannelHandlerContext context) {
                        activations.incrementAndGet();
                        context.fireChannelActive();
                    }
                }).connect(new java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 25565));
        return future;
    }

    static void awaitConnecting(ChannelFuture future, ScriptedExchange gateway) throws InterruptedException {
        // Bootstrap may enqueue connect after channel registration completes.
        // An event-loop no-op can run between those two tasks; observe the
        // actual open operation before replying to the scripted connection.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        do {
            BrowserSocketPump.pump();
            if (gateway.sockets.size() == 1 && !future.isDone()) return;
            if (future.isDone()) {
                throw new AssertionError("connect ended before the gateway observed open: " + future.cause());
            }
            Thread.sleep(1);
        } while (System.nanoTime() < deadline);
        throw new AssertionError("gateway did not observe the pending connect within 2 seconds");
    }

    static void checkIdle(ScriptedExchange gateway, String what) {
        int calls = gateway.calls;
        BrowserSocketPump.pump();
        BrowserSocketPump.pump();
        check(gateway.calls == calls, what);
    }

    static final class ScriptedExchange implements UnaryOperator<String> {
        final Map<String, JsonObject> sockets = new LinkedHashMap<>();
        int calls;
        int closes;

        void reply(String state, String error) {
            for (JsonObject socket : sockets.values()) {
                socket.addProperty("state", state);
                if (error != null) socket.addProperty("error", error);
            }
        }

        @Override
        public String apply(String requestJson) {
            calls++;
            for (JsonElement element : JsonParser.parseString(requestJson).getAsJsonObject().getAsJsonArray("ops")) {
                JsonObject op = element.getAsJsonObject();
                String id = op.get("id").getAsString();
                switch (op.get("op").getAsString()) {
                    case "open" -> {
                        JsonObject socket = new JsonObject();
                        socket.addProperty("state", "connecting");
                        sockets.put(id, socket);
                    }
                    case "close" -> { closes++; sockets.remove(id); }
                    default -> { }
                }
            }
            JsonObject report = new JsonObject();
            sockets.forEach(report::add);
            sockets.values().removeIf(socket -> socket.get("state").getAsString().equals("error"));
            JsonObject response = new JsonObject();
            response.add("sockets", report);
            return response.toString();
        }
    }

    static void formats() {
        UUID player = new UUID(0x0123456789abcdefL, 0x0fedcba987654321L);
        System.out.println("protocol " + SharedConstants.getProtocolVersion());
        print("login-disconnect", PacketWire.encode(LoginProtocols.CLIENTBOUND,
                new ClientboundLoginDisconnectPacket(Component.literal("mock: login refused"))));
        print("login-finished", PacketWire.encode(LoginProtocols.CLIENTBOUND,
                new ClientboundLoginFinishedPacket(new GameProfile(player, "MockPlayer"), player)));
        print("config-disconnect", PacketWire.encode(ConfigurationProtocols.CLIENTBOUND,
                new ClientboundDisconnectPacket(Component.literal("mock: configuration reached"))));
        print("hello", PacketWire.encode(LoginProtocols.SERVERBOUND, new ServerboundHelloPacket("Tester", player)));
        print("login-ack", PacketWire.encode(LoginProtocols.SERVERBOUND, ServerboundLoginAcknowledgedPacket.INSTANCE));
    }

    static void print(String name, byte[] bytes) {
        System.out.println(name + " " + HexFormat.of().formatHex(bytes));
    }

    static void ping() throws Exception {
        ServerData data = new ServerData("mock", "127.0.0.1:" + PORT, ServerData.Type.OTHER);
        ServerStatusPinger pinger = new ServerStatusPinger();
        // The second callback is vanilla's "persistent data changed" (the
        // icon); the third runs when the ping completes.
        CountDownLatch done = new CountDownLatch(1);
        pinger.pingServer(data, () -> { }, done::countDown, BrowserNet.remote(false));
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (done.getCount() > 0 && System.nanoTime() < until) {
            pinger.tick();
            Thread.sleep(50);
        }
        String motd = data.motd == null ? "null" : data.motd.getString();
        System.out.println("ping: motd=" + motd + " players=" + data.players + " ping=" + data.ping + "ms state=" + data.state());
        check(done.getCount() == 0 && motd.contains("MC-Web mock") && data.players != null
                && data.players.online() == 3 && data.ping >= 0, "server list ping through the gateway");
        pinger.removeAll();
    }

    /** Logs in as far as configuration; the mock then disconnects with a reason. */
    static void login(String mock) throws Exception {
        ServerAddress address = new ServerAddress("127.0.0.1", PORT);
        java.net.InetSocketAddress resolved = BrowserNet.resolveAddress(null, address).orElseThrow().asInetSocketAddress();
        Connection connection = new Connection(PacketFlow.CLIENTBOUND);
        long start = System.nanoTime();
        Connection.connect(resolved, BrowserNet.remote(false), connection).syncUninterruptibly();
        System.out.printf("login(%s): connected in %d ms%n", mock, (System.nanoTime() - start) / 1_000_000);
        CountDownLatch ended = new CountDownLatch(1);
        AtomicReference<String> finished = new AtomicReference<>();
        AtomicReference<String> reason = new AtomicReference<>();
        ClientConfigurationPacketListener configuration = listener(ClientConfigurationPacketListener.class,
                ConnectionProtocol.CONFIGURATION, Map.of(
                        "handleDisconnect", (a) -> {
                            Component why = ((ClientboundDisconnectPacket) a[0]).reason();
                            reason.set("configuration: " + why.getString());
                            connection.disconnect(why);
                        }), reason, ended);
        ClientLoginPacketListener login = listener(ClientLoginPacketListener.class, ConnectionProtocol.LOGIN, Map.of(
                "handleLoginFinished", (a) -> {
                    GameProfile profile = ((ClientboundLoginFinishedPacket) a[0]).gameProfile();
                    finished.set(profile.name() + " " + profile.id());
                    connection.setupInboundProtocol(ConfigurationProtocols.CLIENTBOUND, configuration);
                    connection.send(ServerboundLoginAcknowledgedPacket.INSTANCE);
                    connection.setupOutboundProtocol(ConfigurationProtocols.SERVERBOUND);
                },
                "handleDisconnect", (a) -> {
                    Component why = ((ClientboundLoginDisconnectPacket) a[0]).reason();
                    reason.set("login: " + why.getString());
                    connection.disconnect(why);
                }), reason, ended);
        connection.initiateServerboundPlayConnection("127.0.0.1#" + mock, PORT, login);
        connection.send(new ServerboundHelloPacket("Tester", UUID.nameUUIDFromBytes("OfflinePlayer:Tester".getBytes())));
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (ended.getCount() > 0 && System.nanoTime() < until) {
            connection.tick();
            Thread.sleep(20);
        }
        connection.handleDisconnection();
        System.out.printf("login(%s): finished=%s reason=%s after %d ms%n", mock, finished.get(), reason.get(),
                (System.nanoTime() - start) / 1_000_000);
        if (mock.equals("ok")) {
            check(finished.get() != null && finished.get().startsWith("Tester "), "login finished with the server's profile");
            check(reason.get() != null && reason.get().startsWith("configuration: mock: configuration reached"),
                    "configuration reached; the long, compressed disconnect reason arrived");
        } else {
            check(reason.get() != null && reason.get().equals("login: mock: login refused"), "a login disconnect reason arrives");
        }
    }

    /** The gateway accepts the socket, then cannot reach the server (nothing listens on probe.deadPort). */
    static void noServer() throws Exception {
        int dead = Integer.getInteger("probe.deadPort", 25566);
        ServerAddress address = new ServerAddress("127.0.0.1", dead);
        java.net.InetSocketAddress resolved = BrowserNet.resolveAddress(null, address).orElseThrow().asInetSocketAddress();
        Connection connection = new Connection(PacketFlow.CLIENTBOUND);
        long start = System.nanoTime();
        Throwable connectFailure = null;
        try {
            Connection.connect(resolved, BrowserNet.remote(false), connection).syncUninterruptibly();
        } catch (Throwable thrown) {
            connectFailure = thrown;
        }
        CountDownLatch ended = new CountDownLatch(1);
        AtomicReference<String> reason = new AtomicReference<>();
        if (connectFailure == null) {
            ClientLoginPacketListener login = listener(ClientLoginPacketListener.class, ConnectionProtocol.LOGIN,
                    Map.of(), reason, ended);
            connection.initiateServerboundPlayConnection("127.0.0.1", dead, login);
            connection.send(new ServerboundHelloPacket("Tester", UUID.nameUUIDFromBytes("OfflinePlayer:Tester".getBytes())));
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            // As ConnectScreen.tick does: tick while connected, then hand the
            // disconnection to the listener.
            while (ended.getCount() > 0 && System.nanoTime() < until) {
                if (connection.isConnected()) connection.tick();
                else connection.handleDisconnection();
                Thread.sleep(20);
            }
        }
        System.out.printf("no server: connectFailure=%s reason=%s connected=%s after %d ms%n", connectFailure, reason.get(),
                connection.isConnected(), (System.nanoTime() - start) / 1_000_000);
        check(connectFailure != null && String.valueOf(connectFailure.getMessage()).contains("ECONNREFUSED"),
                "a server the gateway cannot reach fails the connect with the gateway's reason");
    }

    static void refusedTarget() {
        ServerAddress address = new ServerAddress("127.0.0.1", 25599);
        java.net.InetSocketAddress resolved = BrowserNet.resolveAddress(null, address).orElseThrow().asInetSocketAddress();
        Connection connection = new Connection(PacketFlow.CLIENTBOUND);
        Throwable failure = null;
        try {
            Connection.connect(resolved, BrowserNet.remote(false), connection).syncUninterruptibly();
        } catch (Throwable thrown) {
            failure = thrown;
        }
        System.out.println("refused target: " + failure);
        check(failure instanceof java.net.ConnectException, "a target the gateway refuses fails the connect with its reason");
    }

    interface Handler {
        void handle(Object[] args) throws Exception;
    }

    /** A packet listener for the probe: named handlers, everything else reported. */
    @SuppressWarnings("unchecked")
    static <T> T listener(Class<T> type, ConnectionProtocol protocol, Map<String, Handler> handlers,
            AtomicReference<String> reason, CountDownLatch ended) {
        InvocationHandler invocation = (proxy, method, args) -> {
            String name = method.getName();
            switch (name) {
                case "protocol": return protocol;
                case "isAcceptingMessages": return true;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return proxy == args[0];
                case "toString": return "probe-" + protocol;
                case "onDisconnect":
                    if (reason.get() == null) reason.set("disconnected: " + ((DisconnectionDetails) args[0]).reason().getString());
                    ended.countDown();
                    return null;
                default:
            }
            Handler handler = handlers.get(name);
            if (handler != null) {
                handler.handle(args);
                return null;
            }
            if (method.isDefault()) return InvocationHandler.invokeDefault(proxy, method, args);
            System.out.println("  (" + protocol + " packet not handled by the probe: " + name + ")");
            return null;
        };
        return (T) Proxy.newProxyInstance(WebSocketLinkProbe.class.getClassLoader(), new Class<?>[] { type }, invocation);
    }

    /** mcWebNet.exchange's contract (web/mc-net.js), over java.net.http. */
    static final class JdkExchange implements UnaryOperator<String> {
        final HttpClient client = HttpClient.newHttpClient();
        final Map<Integer, Socket> sockets = new ConcurrentHashMap<>();

        static final class Socket {
            volatile String state = "connecting";
            volatile String error = "";
            volatile WebSocket ws;
            volatile int compression = -1;
            boolean wasOpen;
            boolean reportedOpen;
            final ConcurrentLinkedQueue<byte[]> inbound = new ConcurrentLinkedQueue<>();
            final List<ByteBuffer> outbound = new ArrayList<>();
            CompletableFuture<?> sending = CompletableFuture.completedFuture(null);
            final ByteArrayOutputStream fragment = new ByteArrayOutputStream();

            synchronized void fail(String why) {
                if (state.equals("closed") || state.equals("error")) return;
                error = why == null || why.isBlank() ? "connection failed" : why;
                state = "error";
                if (ws != null) ws.abort();
            }

            /** The gateway reached the server (its {"connected":true} frame). */
            synchronized void connected() {
                if (!state.equals("connecting")) return;
                state = "open";
                wasOpen = true;
                for (ByteBuffer body : outbound) sending = sending.thenCompose((ignored) -> ws.sendBinary(body, true));
                outbound.clear();
            }

            synchronized void send(ByteBuffer body) {
                if (state.equals("open")) {
                    sending = sending.thenCompose((ignored) -> ws.sendBinary(body, true));
                } else if (state.equals("connecting")) {
                    outbound.add(body);
                }
            }

            void frame(byte[] frame) {
                if (compression < 0) {
                    inbound.add(frame);
                    return;
                }
                int size = 0;
                int shift = 0;
                int at = 0;
                while (true) {
                    int b = frame[at++];
                    size |= (b & 0x7f) << shift;
                    shift += 7;
                    if ((b & 0x80) == 0) break;
                }
                byte[] body = java.util.Arrays.copyOfRange(frame, at, frame.length);
                if (size == 0) {
                    inbound.add(body);
                    return;
                }
                Inflater inflater = new Inflater();
                inflater.setInput(body);
                byte[] out = new byte[size];
                try {
                    int n = inflater.inflate(out);
                    if (n != size) throw new IllegalStateException("inflated " + n + " of " + size);
                    inbound.add(out);
                } catch (Exception bad) {
                    fail(bad.toString());
                } finally {
                    inflater.end();
                }
            }
        }

        void open(int id, String host, int port) {
            Socket s = new Socket();
            sockets.put(id, s);
            URI uri = URI.create(GATEWAY + "?host=" + host + "&port=" + port);
            client.newWebSocketBuilder().buildAsync(uri, new WebSocket.Listener() {
                @Override
                public void onOpen(WebSocket ws) {
                    s.ws = ws;
                    ws.request(1);
                }

                @Override
                public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
                    byte[] chunk = new byte[data.remaining()];
                    data.get(chunk);
                    s.fragment.writeBytes(chunk);
                    if (last) {
                        s.frame(s.fragment.toByteArray());
                        s.fragment.reset();
                    }
                    ws.request(1);
                    return null;
                }

                @Override
                public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                    JsonObject control = JsonParser.parseString(data.toString()).getAsJsonObject();
                    if (control.has("connected")) s.connected();
                    if (control.has("compression")) s.compression = control.get("compression").getAsInt();
                    ws.request(1);
                    return null;
                }

                @Override
                public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
                    if (reason != null && !reason.isBlank()) s.fail(reason);
                    else if (s.state.equals("connecting")) s.fail("closed before connecting");
                    else if (s.state.equals("open")) s.state = "closed";
                    return null;
                }

                @Override
                public void onError(WebSocket ws, Throwable error) {
                    s.fail(error.toString());
                }
            }).whenComplete((ws, error) -> {
                synchronized (s) {
                    if (error != null) {
                        s.fail(error.getCause() != null ? error.getCause().toString() : error.toString());
                        return;
                    }
                    s.ws = ws;
                }
            });
        }

        @Override
        public String apply(String requestJson) {
            JsonObject request = JsonParser.parseString(requestJson).getAsJsonObject();
            for (JsonElement element : request.getAsJsonArray("ops")) {
                JsonObject op = element.getAsJsonObject();
                int id = op.get("id").getAsInt();
                Socket s = sockets.get(id);
                switch (op.get("op").getAsString()) {
                    case "open" -> { if (s == null) open(id, op.get("host").getAsString(), op.get("port").getAsInt()); }
                    case "send" -> { if (s != null) s.send(ByteBuffer.wrap(Base64.getDecoder().decode(op.get("data").getAsString()))); }
                    case "close" -> {
                        if (s != null) {
                            s.state = "closed";
                            if (s.ws != null) s.ws.sendClose(WebSocket.NORMAL_CLOSURE, "");
                            sockets.remove(id);
                        }
                    }
                    default -> { }
                }
            }
            JsonObject report = new JsonObject();
            for (Map.Entry<Integer, Socket> entry : sockets.entrySet()) {
                Socket s = entry.getValue();
                boolean ended = s.state.equals("closed") || s.state.equals("error");
                boolean settled = !ended || s.reportedOpen || !s.wasOpen;
                JsonObject one = new JsonObject();
                String state = settled ? s.state : "open";
                if (state.equals("open")) s.reportedOpen = true;
                one.addProperty("state", state);
                if (settled && !s.error.isEmpty()) one.addProperty("error", s.error);
                ByteArrayOutputStream blob = new ByteArrayOutputStream();
                for (byte[] body; (body = s.inbound.poll()) != null; ) {
                    blob.write(body.length >>> 24);
                    blob.write(body.length >>> 16);
                    blob.write(body.length >>> 8);
                    blob.write(body.length);
                    blob.writeBytes(body);
                }
                if (blob.size() > 0) one.addProperty("in", Base64.getEncoder().encodeToString(blob.toByteArray()));
                report.add(String.valueOf(entry.getKey()), one);
                if (ended && settled) sockets.remove(entry.getKey());
            }
            JsonObject response = new JsonObject();
            response.add("sockets", report);
            return response.toString();
        }
    }
}
