import io.netty.bootstrap.Bootstrap;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.ByteBufAllocator;
import io.netty.buffer.Unpooled;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.DefaultChannelId;
import io.netty.channel.DefaultEventLoopGroup;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.IoHandle;
import io.netty.channel.IoHandler;
import io.netty.channel.IoHandlerContext;
import io.netty.channel.IoHandlerFactory;
import io.netty.channel.IoRegistration;
import io.netty.channel.MultiThreadIoEventLoopGroup;
import io.netty.channel.ServerChannel;
import io.netty.channel.local.LocalAddress;
import io.netty.channel.local.LocalChannel;
import io.netty.channel.local.LocalIoHandler;
import io.netty.channel.local.LocalServerChannel;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.ThreadAwareExecutor;
import io.netty.util.internal.PlatformDependent;
import net.minecraft.client.multiplayer.resolver.ServerNameResolver;
import net.minecraft.client.server.LanServerDetection;
import net.minecraft.server.network.EventLoopGroupHolder;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Stage 0 of docs/NET-MIGRATION.md: harnesses H1 (HotSpot, --limit-modules to
 * the bundle's four modules) and H2 (the same class on the wasm JVM under node).
 *
 * Run with Mojang's massaged jar and the runtime libraries on the class path and
 * WITHOUT the port classes, so Mojang's own network classes and real Netty are
 * what links. Every probe is isolated in its own try/catch(Throwable) and prints
 * the throwable's class (and cause chain) or the value.
 *
 * System properties:
 *   probe.echo=N        messages per echo run (default 1000)
 *   probe.idleMs=N      idle window for the wakeup count (default 10000; 0 skips)
 *   probe.skip=a,b      skip named sections (resolver, lan, mojangLocal, ioLocal, defaultGroup, remote)
 *   probe.trace=true    print stack frames for every throwable caught
 *
 * MC-Web test code that calls Mojang's API; it is not shipped and restates none of it.
 */
public class LinkProbe {
    static final long T0 = System.nanoTime();
    static final int ECHO = Integer.getInteger("probe.echo", 1000);
    static final long IDLE_MS = Long.getLong("probe.idleMs", 10_000L);
    static final List<String> SKIP = Arrays.asList(System.getProperty("probe.skip", "").split(","));

    public static void main(String[] args) throws Exception {
        out("vm=" + System.getProperty("java.vm.name") + " " + System.getProperty("java.version")
                + " os.name=" + System.getProperty("os.name") + " arch=" + System.getProperty("os.arch"));
        for (String p : new String[] {"io.netty.machineId", "io.netty.processId", "io.netty.transport.noNative",
                "io.netty.eventLoopThreads", "io.netty.allocator.type", "io.netty.noPreferDirect",
                "io.netty.leakDetection.level", "io.netty.noUnsafe"}) {
            out("prop " + p + "=" + System.getProperty(p));
        }
        out("modules=" + ModuleLayer.boot().modules().stream().map(Module::getName).sorted().toList());
        census("threads-before");

        step("PlatformDependent.hasUnsafe()", PlatformDependent::hasUnsafe);
        step("PlatformDependent.getUnsafeUnavailabilityCause()", () -> describe(PlatformDependent.getUnsafeUnavailabilityCause()));
        step("PlatformDependent.directBufferPreferred()", PlatformDependent::directBufferPreferred);
        step("ByteBufAllocator.DEFAULT class", () -> ByteBufAllocator.DEFAULT.getClass().getName());
        step("ByteBufAllocator.DEFAULT.buffer().isDirect()", () -> releaseAnd(ByteBufAllocator.DEFAULT.buffer(64)));
        step("ByteBufAllocator.DEFAULT.ioBuffer().isDirect()", () -> releaseAnd(ByteBufAllocator.DEFAULT.ioBuffer(64)));
        step("Unpooled.buffer().isDirect()", () -> releaseAnd(Unpooled.buffer(64)));
        step("PlatformDependent.canReliabilyFreeDirectBuffers()", PlatformDependent::canReliabilyFreeDirectBuffers);
        step("PlatformDependent.CLEANER class", () -> {
            java.lang.reflect.Field f = PlatformDependent.class.getDeclaredField("CLEANER");
            f.setAccessible(true);
            return f.get(null).getClass().getName();
        });
        // Mojang's encoders use MessageToByteEncoder's default constructor (preferDirect), so their
        // output buffer comes from ctx.alloc().ioBuffer(); this shows what that is on this VM.
        step("Varint21LengthFieldPrepender output isDirect (EmbeddedChannel)", () -> {
            io.netty.channel.embedded.EmbeddedChannel ch =
                    new io.netty.channel.embedded.EmbeddedChannel(new net.minecraft.network.Varint21LengthFieldPrepender());
            ch.writeOutbound(Unpooled.buffer(16).writeZero(16));
            ByteBuf o = ch.readOutbound();
            String r = o.isDirect() + " (" + o.getClass().getSimpleName() + ", " + o.readableBytes() + " bytes)";
            o.release();
            ch.finishAndReleaseAll();
            return r;
        });
        step("DefaultChannelId.newInstance()", () -> DefaultChannelId.newInstance().asLongText());

        if (!SKIP.contains("resolver")) {
            step("ServerNameResolver.DEFAULT", () -> String.valueOf(ServerNameResolver.DEFAULT));
        }
        if (!SKIP.contains("lan")) {
            step("new LanServerDetector(new LanServerList())", () -> {
                Thread t = new LanServerDetection.LanServerDetector(new LanServerDetection.LanServerList());
                return "constructed (not started): " + t.getName() + " daemon=" + t.isDaemon();
            });
        }

        List<EventLoopGroup> toClose = new ArrayList<>();
        if (!SKIP.contains("mojangLocal")) {
            step("echo on EventLoopGroupHolder.local()", () -> {
                EventLoopGroupHolder h = EventLoopGroupHolder.local();
                EventLoopGroup g = h.eventLoopGroup();
                toClose.add(g);
                return "group=" + g.getClass().getName() + " channel=" + h.channelCls().getName()
                        + " server=" + h.serverChannelCls().getName() + " | "
                        + echo("mojang", g, h.channelCls(), h.serverChannelCls(), null, null)
                        + " | " + drift(g);
            });
        }
        if (!SKIP.contains("ioLocal")) {
            step("echo on MultiThreadIoEventLoopGroup(1, LocalIoHandler) [counted]", () -> {
                AtomicLong runs = new AtomicLong();
                AtomicLong wakeups = new AtomicLong();
                EventLoopGroup g = new MultiThreadIoEventLoopGroup(1, counting(LocalIoHandler.newFactory(), runs, wakeups));
                toClose.add(g);
                return echo("iolocal", g, LocalChannel.class, LocalServerChannel.class, runs, wakeups)
                        + " | " + drift(g);
            });
        }
        if (!SKIP.contains("defaultGroup")) {
            step("echo on DefaultEventLoopGroup(1) [F1]", () -> {
                EventLoopGroup g = new DefaultEventLoopGroup(1);
                toClose.add(g);
                return echo("default", g, LocalChannel.class, LocalServerChannel.class, null, null) + " | " + drift(g);
            });
        }
        if (!SKIP.contains("remote")) {
            step("EventLoopGroupHolder.remote(false) (holder only)", () -> {
                EventLoopGroupHolder h = EventLoopGroupHolder.remote(false);
                return h.getClass().getName() + " channel=" + h.channelCls().getName();
            });
            step("EventLoopGroupHolder.remote(true) (holder only)", () -> {
                EventLoopGroupHolder h = EventLoopGroupHolder.remote(true);
                return h.getClass().getName() + " channel=" + h.channelCls().getName();
            });
        }

        census("threads-after-echo");
        for (EventLoopGroup g : toClose) {
            step("shutdown " + g.getClass().getSimpleName(), () -> {
                boolean ok = g.shutdownGracefully(0, 1, TimeUnit.SECONDS).await(10, TimeUnit.SECONDS);
                return "terminated=" + ok;
            });
        }
        Thread.sleep(200);
        census("threads-after-shutdown");
        out("done in " + ms(System.nanoTime() - T0) + " ms");
        System.out.flush();
        System.exit(0);
    }

    // ---------------------------------------------------------------- echo

    static String echo(String tag, EventLoopGroup g, Class<? extends Channel> chCls,
                       Class<? extends ServerChannel> srvCls,
                       AtomicLong runs, AtomicLong wakeups) throws Exception {
        LocalAddress addr = new LocalAddress("linkprobe-" + tag);
        long tBind = System.nanoTime();
        ChannelFuture bf = new ServerBootstrap().group(g).channel(srvCls)
                .childHandler(new ChannelInitializer<Channel>() {
                    @Override protected void initChannel(Channel ch) {
                        ch.pipeline().addLast(new ChannelInboundHandlerAdapter() {
                            @Override public void channelRead(ChannelHandlerContext ctx, Object msg) {
                                ctx.writeAndFlush(msg);
                            }
                        });
                    }
                }).bind(addr);
        if (!bf.await(30, TimeUnit.SECONDS)) return "FAIL bind timeout";
        if (!bf.isSuccess()) return "FAIL bind " + describe(bf.cause());
        Channel server = bf.channel();
        long bindMs = ms(System.nanoTime() - tBind);

        LinkedBlockingQueue<Object> inbox = new LinkedBlockingQueue<>();
        long tConn = System.nanoTime();
        ChannelFuture cf = new Bootstrap().group(g).channel(chCls)
                .handler(new ChannelInboundHandlerAdapter() {
                    @Override public void channelRead(ChannelHandlerContext ctx, Object msg) {
                        inbox.add(msg);
                    }
                }).connect(addr);
        if (!cf.await(30, TimeUnit.SECONDS)) return "FAIL connect timeout";
        if (!cf.isSuccess()) return "FAIL connect " + describe(cf.cause());
        Channel client = cf.channel();
        long connMs = ms(System.nanoTime() - tConn);

        // Ping-pong: one message in flight at a time, RTT per message.
        long[] rtt = new long[ECHO];
        int ok = 0;
        long tPing = System.nanoTime();
        for (int i = 0; i < ECHO; i++) {
            ByteBuf b = Unpooled.buffer(64).writeInt(i).writeZero(60);
            long s = System.nanoTime();
            client.writeAndFlush(b);
            Object r = inbox.poll(30, TimeUnit.SECONDS);
            rtt[i] = System.nanoTime() - s;
            if (r == null) return "FAIL ping-pong timeout at " + i + " (bind " + bindMs + " ms, connect " + connMs + " ms)";
            ByteBuf rb = (ByteBuf) r;
            if (rb.readableBytes() == 64 && rb.getInt(0) == i) ok++;
            rb.release();
        }
        long pingMs = ms(System.nanoTime() - tPing);
        Arrays.sort(rtt);

        // Burst: all messages written, one flush, then drained.
        long tBurst = System.nanoTime();
        for (int i = 0; i < ECHO; i++) client.write(Unpooled.buffer(64).writeInt(i).writeZero(60));
        client.flush();
        int burstOk = 0;
        for (int i = 0; i < ECHO; i++) {
            Object r = inbox.poll(30, TimeUnit.SECONDS);
            if (r == null) break;
            ByteBuf rb = (ByteBuf) r;
            if (rb.getInt(0) == i) burstOk++;
            rb.release();
        }
        long burstMs = ms(System.nanoTime() - tBurst);

        String idle = "";
        if (runs != null && IDLE_MS > 0) {
            long r0 = runs.get(), w0 = wakeups.get();
            Thread.sleep(IDLE_MS);
            idle = String.format(" idle %d ms (channels open): IoHandler.run calls=%d wakeup calls=%d;",
                    IDLE_MS, runs.get() - r0, wakeups.get() - w0);
        }

        long tClose = System.nanoTime();
        boolean cClosed = client.close().await(10, TimeUnit.SECONDS);
        boolean sClosed = server.close().await(10, TimeUnit.SECONDS);
        long closeMs = ms(System.nanoTime() - tClose);

        String res = String.format("%s ping-pong %d/%d ok in %d ms (p50 %.1f us, p99 %.1f us, max %.1f us);"
                        + " burst %d/%d in %d ms; bind %d ms, connect %d ms, close %d ms (closed %s/%s);%s"
                        + " client=%s loop=%s",
                ok == ECHO && burstOk == ECHO ? "PASS" : "FAIL",
                ok, ECHO, pingMs, us(rtt[ECHO / 2]), us(rtt[(int) (ECHO * 0.99)]), us(rtt[ECHO - 1]),
                burstOk, ECHO, burstMs, bindMs, connMs, closeMs, cClosed, sClosed, idle,
                client.getClass().getSimpleName(), client.eventLoop().getClass().getSimpleName());
        if (runs != null) res += " totalRuns=" + runs.get() + " totalWakeups=" + wakeups.get();
        return res;
    }

    /** Ten sequential 50 ms schedules on the group; reports how late each fired. */
    static String drift(EventLoopGroup g) throws Exception {
        EventExecutor ex = g.next();
        long sum = 0, max = 0;
        for (int i = 0; i < 10; i++) {
            long s = System.nanoTime();
            long[] fired = new long[1];
            ex.schedule(() -> { fired[0] = System.nanoTime(); }, 50, TimeUnit.MILLISECONDS)
                    .await(10, TimeUnit.SECONDS);
            if (fired[0] == 0) return "drift: schedule " + i + " never fired";
            long late = fired[0] - s - TimeUnit.MILLISECONDS.toNanos(50);
            sum += late;
            max = Math.max(max, late);
        }
        return String.format("drift 10x50ms: mean late %.2f ms, max late %.2f ms", sum / 10 / 1e6, max / 1e6);
    }

    static IoHandlerFactory counting(IoHandlerFactory f, AtomicLong runs, AtomicLong wakeups) {
        return new IoHandlerFactory() {
            @Override public IoHandler newHandler(ThreadAwareExecutor ex) {
                IoHandler d = f.newHandler(ex);
                return new IoHandler() {
                    @Override public void initialize() { d.initialize(); }
                    @Override public int run(IoHandlerContext ctx) { runs.incrementAndGet(); return d.run(ctx); }
                    @Override public void prepareToDestroy() { d.prepareToDestroy(); }
                    @Override public void destroy() { d.destroy(); }
                    @Override public IoRegistration register(IoHandle h) throws Exception { return d.register(h); }
                    @Override public void wakeup() { wakeups.incrementAndGet(); d.wakeup(); }
                    @Override public boolean isCompatible(Class<? extends IoHandle> c) { return d.isCompatible(c); }
                };
            }
            @Override public boolean isChangingThreadSupported() { return f.isChangingThreadSupported(); }
        };
    }

    // ---------------------------------------------------------------- helpers

    static void step(String name, Callable<Object> c) {
        long s = System.nanoTime();
        try {
            Object v = c.call();
            out(name + " = " + v + "  [" + ms(System.nanoTime() - s) + " ms]");
        } catch (Throwable t) {
            out(name + " THREW " + describe(t) + "  [" + ms(System.nanoTime() - s) + " ms]");
            if (Boolean.getBoolean("probe.trace")) {
                for (Throwable e = t; e != null; e = e.getCause() == e ? null : e.getCause()) {
                    out("  trace " + e.getClass().getName());
                    StackTraceElement[] st = e.getStackTrace();
                    for (int i = 0; i < Math.min(st.length, 14); i++) out("    at " + st[i]);
                }
            }
        }
    }

    static String describe(Throwable t) {
        if (t == null) return "null";
        StringBuilder sb = new StringBuilder();
        int depth = 0;
        for (Throwable c = t; c != null && depth < 6; c = c.getCause(), depth++) {
            if (depth > 0) sb.append(" <- caused by ");
            sb.append(c.getClass().getName());
            if (c.getMessage() != null) sb.append(": ").append(c.getMessage());
            if (c.getCause() == c) break;
        }
        return sb.toString();
    }

    static Object releaseAnd(ByteBuf b) {
        boolean d = b.isDirect();
        String cls = b.getClass().getSimpleName();
        b.release();
        return d + " (" + cls + ")";
    }

    static void census(String label) {
        try {
            TreeMap<String, Integer> names = new TreeMap<>();
            int daemons = 0;
            var all = Thread.getAllStackTraces().keySet();
            for (Thread t : all) {
                String n = t.getName() + (t.isDaemon() ? " (d)" : "");
                names.merge(n, 1, Integer::sum);
                if (t.isDaemon()) daemons++;
            }
            out(label + ": " + all.size() + " live (" + daemons + " daemon) " + names);
        } catch (Throwable t) {
            out(label + " THREW " + describe(t));
        }
    }

    static long ms(long ns) { return ns / 1_000_000; }
    static double us(long ns) { return ns / 1000.0; }
    static void out(String s) { System.out.println("[linkprobe +" + ms(System.nanoTime() - T0) + "ms] " + s); }
}
