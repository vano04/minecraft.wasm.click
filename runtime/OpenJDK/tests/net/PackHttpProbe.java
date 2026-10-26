import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcweb.graal.BrowserPackHttp;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.UnaryOperator;

/** Host-only HTTP boundary probe; no Minecraft, native networking or browser. */
public class PackHttpProbe {
    private static final ScriptedFetch FETCH = new ScriptedFetch();
    private static int failures;

    public static void main(String[] args) throws Exception {
        Thread.currentThread().setName("probe-client");
        BrowserPackHttp.exchange = FETCH;
        ExecutorService io = Executors.newFixedThreadPool(10, (task) -> new Thread(task, "probe-io"));
        try {
            productionDownloadExecutor();
            partialReads(io);
            errorBody(io);
            timeout(io, "connect-delay", true);
            timeout(io, "read-delay", false);
            cancellationAndConcurrency(io);
            bodyFailure(io);
            failedCancel(io);
            rapidTurnover(io);
            requestCap(io);
            check("browser exchange ran only on the client pump thread", FETCH.wrongThread.get() == null);
            idle();
        } finally {
            io.shutdownNow();
            io.awaitTermination(2, TimeUnit.SECONDS);
            BrowserPackHttp.downloadExecutor().shutdownNow();
            BrowserPackHttp.downloadExecutor().awaitTermination(2, TimeUnit.SECONDS);
        }
        if (failures != 0) throw new AssertionError(failures + " HTTP probe failures");
    }

    private static HttpURLConnection connection(String path) throws Exception {
        return (HttpURLConnection) BrowserPackHttp.openConnection(new URL("https://packs.test/" + path), Proxy.NO_PROXY);
    }

    private static void productionDownloadExecutor() throws Exception {
        Thread client = Thread.currentThread();
        AtomicReference<Thread> downloader = new AtomicReference<>();
        HttpURLConnection connection = connection("stream");
        Future<String> result = BrowserPackHttp.downloadExecutor().submit(() -> {
            downloader.set(Thread.currentThread());
            try (InputStream input = connection.getInputStream()) {
                return new String(input.readAllBytes(), StandardCharsets.UTF_8);
            }
        });
        check("production download executor waits off client while pump completes HTTP",
                finish(result).equals("abcdef") && downloader.get() != client && downloader.get().isDaemon());
        idle();
        // Keep the subsequent partial-read check independent of this download.
        FETCH.totalPulls = 0;
    }

    private static void partialReads(ExecutorService io) throws Exception {
        HttpURLConnection connection = connection("stream");
        connection.setRequestProperty("Minecraft-Version", "26.3");
        connection.setInstanceFollowRedirects(true);
        CountDownLatch firstRead = new CountDownLatch(1), release = new CountDownLatch(1);
        Future<String> result = io.submit(() -> {
            if (connection.getContentLengthLong() != 6 || connection.getResponseCode() != 200)
                throw new AssertionError("metadata differs");
            try (InputStream input = connection.getInputStream()) {
                int first = input.read();
                if (input.available() != 1) throw new AssertionError("partial chunk was not retained");
                firstRead.countDown();
                release.await();
                return Character.toString(first) + new String(input.readAllBytes(), StandardCharsets.UTF_8);
            }
        });
        until(() -> firstRead.getCount() == 0 || result.isDone(), "first partial read");
        for (int i = 0; i < 10; i++) BrowserPackHttp.pump();
        check("partial reads apply backpressure without prefetch", FETCH.totalPulls == 1);
        check("request headers and redirect choice survive the bridge", FETCH.sawHeader && FETCH.sawRedirect);
        release.countDown();
        check("HTTP metadata, partial reads, complete body and EOF", finish(result).equals("abcdef"));
        idle();
    }

    private static void errorBody(ExecutorService io) throws Exception {
        HttpURLConnection connection = connection("not-found");
        Future<String> result = io.submit(() -> {
            try { connection.getInputStream(); throw new AssertionError("404 did not throw"); }
            catch (IOException expected) {
                if (connection.getResponseCode() != 404) throw new AssertionError("status differs");
                try (InputStream error = connection.getErrorStream()) {
                    return new String(error.readAllBytes(), StandardCharsets.UTF_8);
                }
            }
        });
        check("HTTP errors retain their response stream for vanilla logging", finish(result).equals("missing"));
        idle();
    }

    private static void timeout(ExecutorService io, String path, boolean connect) throws Exception {
        HttpURLConnection connection = connection(path);
        if (connect) connection.setConnectTimeout(40); else connection.setReadTimeout(40);
        int cancelled = FETCH.cancels;
        Future<?> result = io.submit(() -> {
            try (InputStream input = connection.getInputStream()) { input.read(); }
            return null;
        });
        Throwable error = failure(result);
        check((connect ? "connect" : "read") + " timeout propagates SocketTimeoutException", error instanceof SocketTimeoutException);
        BrowserPackHttp.pump();
        check((connect ? "connect" : "read") + " timeout cancels and removes browser request", FETCH.cancels == cancelled + 1 && FETCH.live.isEmpty());
        idle();
    }

    private static void cancellationAndConcurrency(ExecutorService io) throws Exception {
        HttpURLConnection blocked = connection("read-delay");
        Future<?> waiting = io.submit(() -> { try (InputStream input = blocked.getInputStream()) { input.read(); } return null; });
        until(() -> FETCH.live.values().stream().anyMatch((r) -> r.url.endsWith("read-delay") && r.pulls > 0), "blocked read");
        HttpURLConnection other = connection("stream");
        Future<String> flowing = io.submit(() -> { try (InputStream input = other.getInputStream()) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        } });
        check("one waiting IO request does not block another", finish(flowing).equals("abcdef") && !waiting.isDone());
        int cancelled = FETCH.cancels;
        blocked.disconnect(); blocked.disconnect();
        check("disconnect wakes blocked IO with IOException", failure(waiting) instanceof IOException);
        BrowserPackHttp.pump();
        check("repeated disconnect cancels exactly once", FETCH.cancels == cancelled + 1);
        idle();
    }

    private static void bodyFailure(ExecutorService io) throws Exception {
        HttpURLConnection connection = connection("broken");
        Future<?> result = io.submit(() -> { try (InputStream input = connection.getInputStream()) {
            if (input.read() != 'a') throw new AssertionError("first bytes lost");
            input.readAllBytes();
        } return null; });
        Throwable error = failure(result);
        check("stream failure follows already delivered bytes and releases request", error instanceof IOException && error.getMessage().contains("scripted fetch body failure"));
        idle();
    }

    private static void requestCap(ExecutorService io) throws Exception {
        ArrayList<HttpURLConnection> connections = new ArrayList<>();
        ArrayList<Future<?>> pending = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            HttpURLConnection connection = connection("connect-delay");
            connections.add(connection);
            pending.add(io.submit(() -> { connection.connect(); return null; }));
        }
        until(() -> FETCH.live.size() == 8, "eight admitted requests");
        HttpURLConnection overflow = connection("connect-delay");
        Future<?> ninth = io.submit(() -> { overflow.connect(); return null; });
        Throwable error = failure(ninth);
        check("active request cap rejects excess without opening another fetch", error instanceof IOException && error.getMessage().contains("too many active") && FETCH.live.size() == 8);
        for (HttpURLConnection connection : connections) connection.disconnect();
        for (Future<?> result : pending) failure(result);
        idle();
    }

    private static void failedCancel(ExecutorService io) throws Exception {
        HttpURLConnection connection = connection("read-delay");
        Future<?> waiting = io.submit(() -> { try (InputStream input = connection.getInputStream()) { input.read(); } return null; });
        until(() -> FETCH.live.values().stream().anyMatch((r) -> r.pulls > 0), "read before lost cancellation");
        connection.disconnect();
        FETCH.dropCancelOnce = true;
        BrowserPackHttp.pump();
        check("failed exchange retains uncertainty instead of assuming cancel succeeded", FETCH.live.size() == 1);
        BrowserPackHttp.pump();
        check("failed exchange retries cancel even after Java request was closed", FETCH.live.isEmpty());
        failure(waiting);
        idle();
    }

    private static void rapidTurnover(ExecutorService io) throws Exception {
        // Produce turnover through the public connection API without pumping.
        // The IO wait is the observable signal that connect queued its open.
        for (int i = 0; i < 90; i++) {
            HttpURLConnection connection = connection("connect-delay");
            CountDownLatch entered = new CountDownLatch(1);
            AtomicReference<Thread> worker = new AtomicReference<>();
            Future<?> waiting = io.submit(() -> {
                worker.set(Thread.currentThread()); entered.countDown(); connection.connect(); return null;
            });
            if (!entered.await(1, TimeUnit.SECONDS)) throw new AssertionError("IO did not start");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (worker.get().getState() != Thread.State.WAITING && !waiting.isDone()) {
                if (System.nanoTime() > deadline) throw new AssertionError("connect did not wait");
                Thread.sleep(1);
            }
            connection.disconnect();
            try { waiting.get(1, TimeUnit.SECONDS); throw new AssertionError("disconnect did not fail connect"); }
            catch (ExecutionException expected) {
                if (!(expected.getCause() instanceof IOException)) throw expected;
            }
        }
        int calls = FETCH.calls;
        BrowserPackHttp.pump(); BrowserPackHttp.pump(); BrowserPackHttp.pump();
        check("rapid open/cancel turnover preserves order across bounded operation batches", FETCH.calls == calls + 3 && FETCH.maxBatch == 64 && FETCH.live.isEmpty());
        idle();
    }

    private static <T> T finish(Future<T> result) throws Exception {
        until(result::isDone, "IO completion");
        return result.get();
    }
    private static Throwable failure(Future<?> result) throws Exception {
        try { finish(result); throw new AssertionError("expected IO failure"); }
        catch (ExecutionException expected) { return expected.getCause(); }
    }
    private static void until(BooleanSupplier ready, String what) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!ready.getAsBoolean()) {
            if (System.nanoTime() > deadline) throw new AssertionError("timed out waiting for " + what);
            BrowserPackHttp.pump();
            Thread.sleep(1);
        }
    }
    private static void idle() {
        BrowserPackHttp.pump(); BrowserPackHttp.pump();
        int calls = FETCH.calls;
        for (int i = 0; i < 10; i++) BrowserPackHttp.pump();
        check("terminal HTTP requests leave no browser state or idle RPC", FETCH.live.isEmpty() && FETCH.calls == calls);
    }
    private static void check(String name, boolean passed) {
        System.out.println((passed ? "PASS " : "FAIL ") + name);
        if (!passed) failures++;
    }

    private static final class ScriptedFetch implements UnaryOperator<String> {
        final Map<Integer, Download> live = new LinkedHashMap<>();
        final AtomicReference<String> wrongThread = new AtomicReference<>();
        int calls, totalPulls, cancels, maxBatch;
        boolean sawHeader, sawRedirect, dropCancelOnce;
        @Override public String apply(String json) {
            calls++;
            if (!Thread.currentThread().getName().equals("probe-client")) wrongThread.set(Thread.currentThread().getName());
            var operations = JsonParser.parseString(json).getAsJsonObject().getAsJsonArray("ops");
            maxBatch = Math.max(maxBatch, operations.size());
            if (operations.size() > 64) throw new AssertionError("operation batch exceeded browser bound");
            if (dropCancelOnce) {
                for (var value : operations) if (value.getAsJsonObject().get("op").getAsString().equals("cancel")) {
                    dropCancelOnce = false;
                    throw new IllegalStateException("lost cancel exchange");
                }
            }
            for (var value : operations) {
                JsonObject op = value.getAsJsonObject();
                int id = op.get("id").getAsInt();
                switch (op.get("op").getAsString()) {
                    case "open" -> {
                        Download download = new Download(op.get("url").getAsString());
                        live.put(id, download);
                        sawHeader |= op.getAsJsonObject("headers").has("Minecraft-Version");
                        sawRedirect |= op.get("followRedirects").getAsBoolean();
                    }
                    case "cancel" -> { if (live.remove(id) != null) cancels++; }
                    case "pull" -> {
                        Download download = live.get(id);
                        if (download != null) { download.pulls++; totalPulls++; download.pull = true; }
                    }
                    default -> throw new AssertionError("unexpected operation");
                }
            }
            JsonObject replies = new JsonObject();
            for (var entry : new ArrayList<>(live.entrySet())) {
                Download download = entry.getValue();
                JsonObject reply = new JsonObject();
                String state = download.url.endsWith("connect-delay") ? "opening" : "streaming";
                if (!state.equals("opening")) {
                    reply.addProperty("status", download.url.endsWith("not-found") ? 404 : 200);
                    reply.addProperty("contentLength", download.body.length);
                }
                if (download.pull && !download.url.endsWith("read-delay")) {
                    if (download.url.endsWith("broken") && download.at > 0) {
                        state = "error"; reply.addProperty("error", "scripted fetch body failure");
                    } else if (download.at == download.body.length) state = "eof";
                    else {
                        int end = Math.min(download.at + 2, download.body.length);
                        reply.addProperty("data", Base64.getEncoder().encodeToString(java.util.Arrays.copyOfRange(download.body, download.at, end)));
                        download.at = end;
                    }
                    download.pull = false;
                }
                reply.addProperty("state", state);
                replies.add(entry.getKey().toString(), reply);
                if (state.equals("eof") || state.equals("error")) live.remove(entry.getKey());
            }
            JsonObject output = new JsonObject(); output.add("requests", replies); return output.toString();
        }
    }
    private static final class Download {
        final String url;
        final byte[] body;
        int at, pulls;
        boolean pull;
        Download(String url) { this.url = url; body = (url.endsWith("not-found") ? "missing" : "abcdef").getBytes(StandardCharsets.UTF_8); }
    }
}
