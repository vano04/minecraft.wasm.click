package dev.mcweb.graal.net;

import io.netty.channel.EventLoopGroup;
import io.netty.channel.IoHandlerFactory;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.util.Optional;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerStatusPinger;
import net.minecraft.client.multiplayer.resolver.ResolvedServerAddress;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.multiplayer.resolver.ServerNameResolver;
import net.minecraft.server.network.EventLoopGroupHolder;
import net.minecraft.server.network.ServerConnectionListener;

/**
 * Where the browser declines what it cannot offer, reached by counted
 * redirects in tools/wasmjvm-massage-plan.mjs so Mojang's own classes run
 * unchanged around them (docs/NET-MIGRATION.md). Each refusal is the
 * IOException Mojang's caller already expects from a machine without the
 * facility, so the game takes its own failure path.
 */
public final class BrowserNet {
    private BrowserNet() {
    }

    /**
     * LAN discovery: replaces the setUncaughtExceptionHandler call in
     * LanServerDetector's constructor, before it opens a MulticastSocket. On
     * the wasm JVM that socket throws an Error (the NIO dispatcher has no
     * multicast) that escapes the multiplayer screen's catch (Exception) and
     * leaves NIO broken for the session; this IOException is the one the
     * screen already handles ("Unable to start LAN server detection").
     */
    public static void refuseLanDetection(Thread detector, Thread.UncaughtExceptionHandler handler)
            throws IOException {
        throw new IOException("LAN server detection is not available in the browser");
    }

    /**
     * Open to LAN: replaces IntegratedServer.publishServer's
     * startTcpServerListener call. A page cannot listen on a TCP port;
     * publishServer catches the IOException and reports the failure.
     */
    public static void refuseTcpListener(ServerConnectionListener listener, InetAddress address, int port)
            throws IOException {
        throw new IOException("a browser page cannot listen for TCP connections");
    }
    /**
     * Remote connections (rule R1 at Mojang's three EventLoopGroupHolder.remote
     * calls: joining, the server list's ping, Realms): Mojang's
     * Connection.connect runs with {@link WebSocketChannel} as its channel, so
     * nothing ever creates an NIO group, which this JVM cannot run.
     */
    public static EventLoopGroupHolder remote(boolean useNativeTransport) {
        return WebSocketHolder.INSTANCE;
    }

    private static final class WebSocketHolder extends EventLoopGroupHolder {
        static final WebSocketHolder INSTANCE = new WebSocketHolder();

        private WebSocketHolder() {
            super("WebSocket", WebSocketChannel.class, null);
        }

        /**
         * Mojang's in-memory group: its one IO thread is idle outside
         * singleplayer, and a channel that only queues work for the frame pump
         * needs no IO handler of its own, so no thread is added.
         */
        @Override
        public EventLoopGroup eventLoopGroup() {
            return EventLoopGroupHolder.local().eventLoopGroup();
        }

        @Override
        protected IoHandlerFactory ioHandlerFactory() {
            throw new UnsupportedOperationException("the WebSocket holder uses the local group");
        }
    }

    /**
     * ServerNameResolver.DEFAULT (rule R7a): its class cannot initialise here
     * (no javax.naming for SRV lookups), and the NoClassDefFoundError would
     * escape every catch (Exception) on the way. Nothing reads the value; the
     * resolveAddress call it feeds goes to {@link #resolveAddress} (R7b).
     */
    public static ServerNameResolver noResolver() {
        return null;
    }

    /**
     * Name resolution happens in the gateway, which also follows SRV records:
     * the page cannot look names up. The address keeps the host name, with
     * 0.0.0.0 as its "resolved" IP, so Netty connects without a DNS lookup and
     * {@link WebSocketChannel} reads the name back with getHostString.
     */
    public static Optional<ResolvedServerAddress> resolveAddress(ServerNameResolver ignored, ServerAddress address) {
        try {
            InetAddress named = InetAddress.getByAddress(address.getHost(), new byte[4]);
            return Optional.of(ResolvedServerAddress.from(new InetSocketAddress(named, address.getPort())));
        } catch (UnknownHostException impossible) {
            return Optional.empty();   // only thrown for a malformed IP length
        }
    }

    /**
     * The pre-1.7 server-list ping Mojang tries after a failed modern ping
     * (rule R4): the gateway speaks only the modern protocol, and the failure
     * the list already shows is the right answer.
     */
    public static void skipLegacyPing(ServerStatusPinger pinger, InetSocketAddress resolved,
            ServerAddress address, ServerData server, EventLoopGroupHolder group) {
    }
}
