package dev.mcweb.graal;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.HttpURLConnection;
import java.net.ProtocolException;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLConnection;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.HashSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.UnaryOperator;
import org.graalvm.webimage.api.JS;

/**
 * HTTP connection boundary for HttpUtil's resource-pack download call only.
 * Mojang still owns the download queue, cache, hashes, limits, ZIP and reload.
 * IO threads wait here; only the client thread may call {@link #pump()} and JS.
 * Counted massage rules redirect HttpUtil.downloadFile's connection and put
 * DownloadQueue's original task executor on this independent waiting thread.
 */
public final class BrowserPackHttp {
    private static final int CHUNK_BYTES = 64 * 1024;
    private static final int MAX_REQUESTS = 8;
    private static final AtomicInteger IDS = new AtomicInteger();
    private static final Map<Integer, Request> LIVE = new ConcurrentHashMap<>();
    private static final ConcurrentLinkedQueue<JsonObject> OPS = new ConcurrentLinkedQueue<>();
    /** Host probes replace only the browser boundary. */
    public static volatile UnaryOperator<String> exchange = BrowserPackHttp::pageExchange;

    private BrowserPackHttp() { }

    /** DownloadQueue's original ConsecutiveExecutor retains its sequencing. */
    public static ExecutorService downloadExecutor() {
        return DownloadExecutor.INSTANCE;
    }

    private static final class DownloadExecutor {
        // The general download domain is inline on this runtime. HTTP waits
        // need a distinct thread so the client can continue pumping replies.
        // Executors creates this single daemon worker only on the first task.
        static final ExecutorService INSTANCE = Executors.newSingleThreadExecutor(task -> {
            Thread worker = new Thread(task, "mcweb-pack-download");
            worker.setDaemon(true);
            return worker;
        });
    }

    public static URLConnection openConnection(URL url, Proxy proxy) throws IOException {
        Objects.requireNonNull(url);
        if (!url.getProtocol().equals("http") && !url.getProtocol().equals("https"))
            throw new IOException("server packs require HTTP or HTTPS");
        if (url.getUserInfo() != null) throw new IOException("browser fetch does not support URL credentials");
        if (proxy != null && proxy.type() != Proxy.Type.DIRECT)
            throw new IOException("server-pack fetch uses the browser's configured proxy");
        return new Connection(url);
    }

    /** Client thread only. Empty outside an active download or pending cancel. */
    public static void pump() {
        if (LIVE.isEmpty() && OPS.isEmpty()) return;
        JsonArray ops = new JsonArray();
        for (int n = 0; n < 64; n++) {
            JsonObject op = OPS.poll();
            if (op == null) break;
            ops.add(op);
        }
        JsonObject input = new JsonObject();
        input.add("ops", ops);
        try {
            String output = exchange.apply(input.toString());
            JsonObject replies = JsonParser.parseString(output).getAsJsonObject().getAsJsonObject("requests");
            if (replies == null) throw new IOException("missing HTTP request replies");
            for (var entry : replies.entrySet()) {
                Request request = LIVE.get(Integer.parseInt(entry.getKey()));
                if (request != null) request.accept(entry.getValue().getAsJsonObject());
            }
        } catch (Exception error) {
            IOException failure = new IOException("server-pack browser exchange failed", error);
            ArrayList<Request> snapshot;
            synchronized (LIVE) { snapshot = new ArrayList<>(LIVE.values()); }
            for (Request request : snapshot) request.fail(failure);
            // The host may have applied some/all operations before the reply
            // failed. In particular, a consumed cancel for an already-closed
            // Java stream must be retried instead of orphaning its fetch.
            HashSet<Integer> uncertain = new HashSet<>();
            for (var value : ops) uncertain.add(value.getAsJsonObject().get("id").getAsInt());
            for (int id : uncertain) OPS.add(op("cancel", id));
        }
    }

    private static JsonObject op(String kind, int id) {
        JsonObject op = new JsonObject();
        op.addProperty("op", kind);
        op.addProperty("id", id);
        return op;
    }

    private static final class Request {
        final int id = IDS.incrementAndGet();
        final long started = System.nanoTime();
        final int connectTimeout, readTimeout;
        boolean metadata, eof, closed, pulling;
        int status;
        long length = -1;
        byte[] bytes;
        int at;
        IOException failure;

        Request(Connection connection) throws IOException {
            connectTimeout = connection.getConnectTimeout();
            readTimeout = connection.getReadTimeout();
            JsonObject open = op("open", id);
            open.addProperty("url", connection.getURL().toExternalForm());
            open.addProperty("followRedirects", connection.getInstanceFollowRedirects());
            JsonObject headers = new JsonObject();
            connection.getRequestProperties().forEach((key, values) -> headers.addProperty(key, String.join(", ", values)));
            open.add("headers", headers);
            synchronized (LIVE) {
                if (LIVE.size() >= MAX_REQUESTS) throw new IOException("too many active server-pack HTTP requests");
                LIVE.put(id, this);
                OPS.add(open);
            }
        }

        synchronized void accept(JsonObject reply) throws IOException {
            if (closed || failure != null) return;
            if (reply.has("status")) {
                status = reply.get("status").getAsInt();
                if (status < 100 || status > 599) throw new IOException("invalid browser HTTP status");
                if (reply.has("contentLength") && !reply.get("contentLength").isJsonNull()) {
                    try { length = Long.parseLong(reply.get("contentLength").getAsString()); }
                    catch (NumberFormatException unknown) { length = -1; }
                    if (length < -1) throw new IOException("negative HTTP content length");
                }
                metadata = true;
            }
            if (reply.has("data")) {
                String base64 = reply.get("data").getAsString();
                if (!pulling || bytes != null || base64.length() > ((CHUNK_BYTES + 2) / 3) * 4)
                    throw new IOException("unexpected or oversized HTTP chunk");
                byte[] decoded = Base64.getDecoder().decode(base64);
                if (decoded.length == 0 || decoded.length > CHUNK_BYTES) throw new IOException("invalid HTTP chunk size");
                bytes = decoded;
                at = 0;
                pulling = false;
            }
            String state = reply.get("state").getAsString();
            if (!state.equals("opening") && !state.equals("streaming") && !state.equals("error") && !state.equals("eof"))
                throw new IOException("invalid browser HTTP state");
            if (state.equals("error")) {
                fail(new IOException(reply.has("error") ? reply.get("error").getAsString() : "browser HTTP failure"));
            } else if (state.equals("eof")) {
                if (!metadata) throw new IOException("browser HTTP EOF without response metadata");
                eof = true;
                pulling = false;
                LIVE.remove(id, this);
            }
            notifyAll();
        }

        synchronized void fail(IOException error) {
            if (closed || failure != null) return;
            failure = error;
            bytes = null;
            pulling = false;
            LIVE.remove(id, this);
            OPS.add(op("cancel", id));
            notifyAll();
        }

        synchronized void close() {
            if (closed) return;
            closed = true;
            bytes = null;
            pulling = false;
            if (LIVE.remove(id, this)) OPS.add(op("cancel", id));
            notifyAll();
        }

        void check() throws IOException {
            if (closed) throw new IOException("server-pack HTTP stream closed");
            if (failure != null) throw failure;
        }

        void await(long deadline, String phase) throws IOException {
            try {
                if (deadline == 0) wait();
                else {
                    long remaining = deadline - System.nanoTime();
                    if (remaining <= 0) {
                        SocketTimeoutException error = new SocketTimeoutException("server-pack HTTP " + phase + " timed out");
                        fail(error);
                        throw error;
                    }
                    TimeUnit.NANOSECONDS.timedWait(this, remaining);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                InterruptedIOException error = new InterruptedIOException("server-pack HTTP " + phase + " interrupted");
                error.initCause(interrupted);
                fail(error);
                throw error;
            }
        }

        synchronized void headers() throws IOException {
            // Fetch exposes response headers, not the underlying TCP connect.
            // Honor both configured bounds at this first observable boundary.
            int timeout = connectTimeout == 0 ? readTimeout : readTimeout == 0 ? connectTimeout : Math.min(connectTimeout, readTimeout);
            long deadline = timeout == 0 ? 0 : started + TimeUnit.MILLISECONDS.toNanos(timeout);
            while (!metadata) { check(); await(deadline, "connect"); }
            check();
        }

        final InputStream stream = new InputStream() {
            @Override public int read() throws IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) == -1 ? -1 : Byte.toUnsignedInt(one[0]);
            }
            @Override public int read(byte[] output, int offset, int count) throws IOException {
                Objects.checkFromIndexSize(offset, count, output.length);
                if (count == 0) return 0;
                synchronized (Request.this) {
                    headers();
                    long deadline = readTimeout == 0 ? 0 : System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(readTimeout);
                    while (true) {
                        check();
                        if (bytes != null) {
                            int n = Math.min(count, bytes.length - at);
                            System.arraycopy(bytes, at, output, offset, n);
                            at += n;
                            if (at == bytes.length) { bytes = null; at = 0; }
                            return n;
                        }
                        if (eof) return -1;
                        if (!pulling) { pulling = true; OPS.add(op("pull", id)); }
                        await(deadline, "read");
                    }
                }
            }
            @Override public int available() throws IOException {
                synchronized (Request.this) { check(); return bytes == null ? 0 : bytes.length - at; }
            }
            @Override public void close() { Request.this.close(); }
        };
    }

    private static final class Connection extends HttpURLConnection {
        private Request request;
        private boolean disconnected;
        Connection(URL url) { super(url); }

        private Request request() throws IOException {
            synchronized (this) {
                if (disconnected) throw new IOException("server-pack HTTP connection disconnected");
                if (request == null) {
                    request = new Request(this);
                    connected = true;
                }
                return request;
            }
        }
        @Override public void connect() throws IOException { request().headers(); }
        @Override public int getResponseCode() throws IOException { Request r = request(); r.headers(); return r.status; }
        @Override public long getContentLengthLong() {
            try { Request r = request(); r.headers(); return r.length; }
            catch (IOException failure) { return -1; } // URLConnection's unknown-length convention; input still throws.
        }
        @Override public int getContentLength() { long n = getContentLengthLong(); return n > Integer.MAX_VALUE ? -1 : (int) n; }
        @Override public InputStream getInputStream() throws IOException {
            Request r = request();
            r.headers();
            if (r.status >= 400) throw new IOException("HTTP " + r.status + " for server pack " + url);
            return r.stream;
        }
        @Override public InputStream getErrorStream() {
            Request r;
            synchronized (this) { r = request; }
            if (r == null) return null;
            synchronized (r) { return r.metadata && r.status >= 400 && !r.closed && r.failure == null ? r.stream : null; }
        }
        @Override public void disconnect() {
            Request r;
            synchronized (this) { disconnected = true; r = request; }
            if (r != null) r.close();
        }
        @Override public boolean usingProxy() { return false; }
        @Override public void setRequestMethod(String method) throws ProtocolException {
            if (!"GET".equals(method)) throw new ProtocolException("server-pack HTTP supports GET only");
            super.setRequestMethod(method);
        }
    }

    @JS.Coerce
    @JS(value = "return globalThis.mcWebPackHttp.exchange(request);", args = {"request"})
    private static native String pageExchange(String request);
}
