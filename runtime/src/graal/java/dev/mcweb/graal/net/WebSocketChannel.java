package dev.mcweb.graal.net;

import io.netty.buffer.ByteBuf;
import io.netty.channel.AbstractChannel;
import io.netty.channel.ChannelConfig;
import io.netty.channel.ChannelMetadata;
import io.netty.channel.ChannelOutboundBuffer;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.ChannelPromise;
import io.netty.channel.ConnectTimeoutException;
import io.netty.channel.DefaultChannelConfig;
import io.netty.channel.EventLoop;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.channels.AlreadyConnectedException;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.ConnectionPendingException;
import java.nio.channels.UnsupportedAddressTypeException;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * A Netty channel over one WebSocket to the app's Minecraft gateway
 * (tools/mc-relay.mjs), so Mojang's own {@code Connection.connect} pipeline
 * runs unchanged in the browser: {@link BrowserNet#remote} hands Mojang this
 * class as the channel to create (docs/NET-MIGRATION.md, stage 3).
 *
 * <p>The gateway speaks whole packet bodies, one WebSocket message each, and
 * terminates encryption and login compression itself. Mojang's pipeline frames
 * packets with a VarInt length ({@code splitter}/{@code prepender}), so writes
 * drop that prefix and reads add it back; nothing above this class knows the
 * transport is not TCP.</p>
 *
 * <p>The socket is not here. Only the client thread can reach the page's
 * {@code mcWebNet}, so this channel queues its opens, writes and closes for
 * {@link BrowserSocketPump}, which carries them across once per frame and
 * hands back state changes and inbound packets; those are applied on the
 * channel's event loop.</p>
 */
public final class WebSocketChannel extends AbstractChannel {
    private static final ChannelMetadata METADATA = new ChannelMetadata(false);

    private enum State { OPEN, CONNECTING, ACTIVE, CLOSED }

    private final ChannelConfig config = new DefaultChannelConfig(this);
    final int socketId = BrowserSocketPump.nextSocketId();
    private volatile State state = State.OPEN;
    private volatile InetSocketAddress remote;

    // Event loop only.
    private ChannelPromise connectPromise;
    private ScheduledFuture<?> connectTimeout;
    private final ArrayDeque<byte[]> inbound = new ArrayDeque<>();
    private boolean reading;
    /** Outbound bytes that do not yet hold a whole length-prefixed frame. */
    private byte[] partial = new byte[0];

    /** Netty's ReflectiveChannelFactory needs a public no-argument constructor. */
    public WebSocketChannel() {
        super(null);
    }

    @Override
    public ChannelConfig config() {
        return config;
    }

    @Override
    public boolean isOpen() {
        return state != State.CLOSED;
    }

    @Override
    public boolean isActive() {
        return state == State.ACTIVE;
    }

    @Override
    public ChannelMetadata metadata() {
        return METADATA;
    }

    @Override
    protected AbstractUnsafe newUnsafe() {
        return new SocketUnsafe();
    }

    @Override
    protected boolean isCompatible(EventLoop loop) {
        return true;
    }

    @Override
    protected SocketAddress localAddress0() {
        return null;
    }

    @Override
    protected SocketAddress remoteAddress0() {
        return remote;
    }

    @Override
    protected void doBind(SocketAddress localAddress) {
        throw new UnsupportedOperationException("a page cannot bind a socket");
    }

    @Override
    protected void doDisconnect() {
        doClose();
    }

    @Override
    protected void doClose() {
        State was = state;
        state = State.CLOSED;
        if (was == State.CONNECTING || was == State.ACTIVE) {
            BrowserSocketPump.close(socketId);
        }
        ChannelPromise promise = connectPromise;
        connectPromise = null;
        cancelConnectTimeout();
        if (promise != null) {
            promise.tryFailure(new ClosedChannelException());
        }
        inbound.clear();
        partial = new byte[0];
    }

    @Override
    protected void doBeginRead() {
        reading = true;
        deliver();
    }

    /** Each length-prefixed frame Mojang's prepender wrote becomes one message. */
    @Override
    protected void doWrite(ChannelOutboundBuffer out) throws Exception {
        for (Object message; (message = out.current()) != null; ) {
            if (!(message instanceof ByteBuf buffer)) {
                out.remove(new UnsupportedOperationException(
                        "unsupported message type: " + message.getClass().getName()));
                continue;
            }
            byte[] bytes = new byte[partial.length + buffer.readableBytes()];
            System.arraycopy(partial, 0, bytes, 0, partial.length);
            buffer.getBytes(buffer.readerIndex(), bytes, partial.length, buffer.readableBytes());
            int at = 0;
            while (true) {
                int length = 0;
                int shift = 0;
                int cursor = at;
                boolean complete = false;
                while (cursor < bytes.length && shift < 35) {
                    int b = bytes[cursor++];
                    length |= (b & 0x7f) << shift;
                    shift += 7;
                    if ((b & 0x80) == 0) {
                        complete = true;
                        break;
                    }
                }
                if (!complete || bytes.length - cursor < length) {
                    break;
                }
                byte[] body = new byte[length];
                System.arraycopy(bytes, cursor, body, 0, length);
                BrowserSocketPump.send(socketId, body);
                at = cursor + length;
            }
            partial = java.util.Arrays.copyOfRange(bytes, at, bytes.length);
            out.remove();
        }
    }

    // ---- from BrowserSocketPump (client thread), applied on the event loop

    void opened() {
        eventLoop().execute(() -> {
            ChannelPromise promise = connectPromise;
            connectPromise = null;
            cancelConnectTimeout();
            if (state != State.CONNECTING || promise == null) {
                return;
            }
            if (promise.isCancelled()) {
                unsafe().close(unsafe().voidPromise());
                return;
            }
            state = State.ACTIVE;
            boolean waited = promise.trySuccess();
            if (waited) {
                pipeline().fireChannelActive();
            } else {
                unsafe().close(unsafe().voidPromise());
            }
        });
    }

    void received(List<byte[]> bodies) {
        eventLoop().execute(() -> {
            if (state != State.ACTIVE) {
                return;
            }
            inbound.addAll(bodies);
            deliver();
        });
    }

    /**
     * The socket closed or failed. Before the connection was up, that fails
     * the connect; after, a reason from the gateway reaches Mojang's
     * exceptionCaught (its disconnect screen shows it), and the channel closes.
     */
    void ended(String error) {
        eventLoop().execute(() -> {
            String why = error == null || error.isBlank() ? null : error;
            if (state == State.CONNECTING) {
                ChannelPromise promise = connectPromise;
                connectPromise = null;
                if (promise != null) {
                    promise.tryFailure(new ConnectException(why == null ? "connection closed" : why));
                }
            } else if (state == State.ACTIVE && why != null) {
                pipeline().fireExceptionCaught(new IOException(why));
            }
            if (state != State.CLOSED) {
                unsafe().close(unsafe().voidPromise());
            }
        });
    }

    private void deliver() {
        if (!reading || inbound.isEmpty()) {
            return;
        }
        ChannelPipeline pipeline = pipeline();
        while (!inbound.isEmpty() && state == State.ACTIVE) {
            byte[] body = inbound.poll();
            ByteBuf frame = alloc().buffer(body.length + 3);
            for (int value = body.length; ; value >>>= 7) {
                if ((value & ~0x7f) == 0) {
                    frame.writeByte(value);
                    break;
                }
                frame.writeByte((value & 0x7f) | 0x80);
            }
            frame.writeBytes(body);
            pipeline.fireChannelRead(frame);
        }
        pipeline.fireChannelReadComplete();
        if (!config.isAutoRead()) {
            reading = false;
        }
    }

    private void cancelConnectTimeout() {
        if (connectTimeout != null) {
            connectTimeout.cancel(false);
            connectTimeout = null;
        }
    }

    private final class SocketUnsafe extends AbstractUnsafe {
        @Override
        public void connect(SocketAddress remoteAddress, SocketAddress localAddress, ChannelPromise promise) {
            if (!ensureOpen(promise)) {
                return;
            }
            if (promise.isCancelled()) {
                close(voidPromise());
                return;
            }
            if (state == State.ACTIVE) {
                promise.setFailure(new AlreadyConnectedException());
                return;
            }
            if (connectPromise != null) {
                promise.setFailure(new ConnectionPendingException());
                return;
            }
            if (!(remoteAddress instanceof InetSocketAddress target)) {
                promise.setFailure(new UnsupportedAddressTypeException());
                return;
            }
            remote = target;
            connectPromise = promise;
            state = State.CONNECTING;
            BrowserSocketPump.open(WebSocketChannel.this, target.getHostString(), target.getPort());
            // ConnectScreen cancels this future before it owns a Connection.
            // Keep it cancellable until the gateway confirms the TCP connect.
            promise.addListener(future -> {
                cancelConnectTimeout();
                if (future.isCancelled()) {
                    close(voidPromise());
                }
            });
            int timeoutMillis = config.getConnectTimeoutMillis();
            if (connectPromise == promise && timeoutMillis > 0) {
                connectTimeout = eventLoop().schedule(() -> {
                    if (connectPromise == promise && state == State.CONNECTING) {
                        promise.tryFailure(new ConnectTimeoutException("connection timed out: " + target));
                        close(voidPromise());
                    }
                }, timeoutMillis, TimeUnit.MILLISECONDS);
            }
        }
    }
}
