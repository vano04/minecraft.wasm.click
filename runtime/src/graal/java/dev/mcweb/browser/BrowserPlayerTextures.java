package dev.mcweb.browser;

import com.mojang.authlib.SignatureState;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.services.ProfileResult;
import com.mojang.authlib.properties.PropertyMap;
import com.google.common.collect.ArrayListMultimap;
import com.google.gson.JsonParser;
import com.google.gson.JsonObject;
import com.google.gson.Gson;
import com.google.gson.InstanceCreator;
import com.mojang.authlib.minecraft.MinecraftProfileTexture;
import com.mojang.authlib.services.MinecraftServicesSessionService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import com.mojang.authlib.minecraft.MinecraftProfileTextures;
import com.mojang.authlib.minecraft.SessionService;
import com.mojang.authlib.properties.Property;
import dev.mcweb.graal.BrowserPackHttp;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Portable JVM transport seams; vanilla owns profile parsing and PNG decode. */
public final class BrowserPlayerTextures {
    private BrowserPlayerTextures() {}

    private static ProfileResult startupProfile;

    /** Bind the ephemeral preload to the actual GameConfig identity once. */
    public static void prepareOwnProfile(UUID id, String name) {
        ProfileResult profile = readOwnProfile(Objects.requireNonNull(id));
        startupProfile = profile != null && profile.profile().name().equals(name) ? profile : null;
        if (Boolean.getBoolean("mcweb.frameDiag")) reportPreload(id, name, startupProfile != null);
    }

    /** Minecraft's offline service mode skips its network profile supplier. */
    public static CompletableFuture<Object> offlineProfileFuture(Object fallback) {
        ProfileResult profile = startupProfile;
        startupProfile = null;
        if (Boolean.getBoolean("mcweb.frameDiag")) {
            net.minecraft.server.Bootstrap.realStdoutPrintln("[player-textures] startup-consume profile=" + (profile != null)
                    + " fallback=" + (fallback != null) + " futureClass=CompletableFuture");
        }
        return CompletableFuture.completedFuture(fallback != null ? fallback : profile);
    }

    private static void reportPreload(UUID id, String name, boolean accepted) {
        boolean present = false, idMatch = false, nameMatch = false, parsed = false;
        int textureProperties = -1;
        try {
            Path path = Path.of("/app/mcweb/own-profile.json");
            present = Files.isRegularFile(path);
            if (present && Files.size(path) <= 96 * 1024) {
                JsonObject value = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8)).getAsJsonObject();
                idMatch = id.toString().replace("-", "").equals(value.get("id").getAsString());
                nameMatch = name.equals(value.get("name").getAsString());
                textureProperties = 0;
                for (var property : value.getAsJsonArray("properties")) {
                    if ("textures".equals(property.getAsJsonObject().get("name").getAsString())) textureProperties++;
                }
                parsed = true;
            }
        } catch (Exception unavailable) { /* Diagnostics never change fallback behavior. */ }
        net.minecraft.server.Bootstrap.realStdoutPrintln("[player-textures] startup-preload present=" + present + " parsed=" + parsed
                + " idMatch=" + idMatch + " nameMatch=" + nameMatch
                + " textureProperties=" + textureProperties + " accepted=" + accepted);
    }

    private static final class Downloads {
        // General Minecraft executors run inline on mobile. HTTP must wait on
        // real daemon threads while the render thread pumps BrowserPackHttp.
        static final ThreadPoolExecutor EXECUTOR = new ThreadPoolExecutor(
                0, 2, 30L, TimeUnit.SECONDS, new ArrayBlockingQueue<>(128), task -> {
                    Thread thread = new Thread(task, "mcweb-player-texture");
                    thread.setDaemon(true);
                    return thread;
                });
    }

    public static <T> CompletableFuture<T> supplyAsync(Supplier<T> supplier, Executor unused) {
        Objects.requireNonNull(supplier);
        Objects.requireNonNull(unused);
        try { return CompletableFuture.supplyAsync(supplier, Downloads.EXECUTOR); }
        catch (RuntimeException failure) { return CompletableFuture.failedFuture(failure); }
    }

    public static URLConnection openConnection(URL url, Proxy proxy) throws java.io.IOException {
        if (!"textures.minecraft.net".equalsIgnoreCase(url.getHost()) || url.getUserInfo() != null
                || url.getPort() != -1 || !(url.getProtocol().equals("http") || url.getProtocol().equals("https"))
                || !url.getPath().matches("/texture/[0-9a-fA-F]{32,64}") || url.getQuery() != null || url.getRef() != null) {
            throw new java.io.IOException("Player textures require the Minecraft texture CDN");
        }
        URL secure = new URL("https", "textures.minecraft.net", url.getFile());
        URLConnection connection = BrowserPackHttp.openConnection(secure, proxy);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        return connection;
    }

    /** The authenticated page preloads public signed properties before Java starts. */
    public static ProfileResult fetchProfile(SessionService service, UUID id, boolean requireSecure) {
        Objects.requireNonNull(service);
        Objects.requireNonNull(id);
        ProfileResult profile = readOwnProfile(id);
        return profile != null ? profile : service.fetchProfile(id, requireSecure);
    }

    private static ProfileResult readOwnProfile(UUID id) {
        Path path = Path.of("/app/mcweb/own-profile.json");
        try {
            if (Files.isRegularFile(path) && Files.size(path) <= 96 * 1024) {
                ProfileResult profile = ownProfile(id, Files.readString(path, StandardCharsets.UTF_8));
                if (profile != null) return profile;
            }
        } catch (Exception unavailable) {
            // A missing/malformed preload keeps vanilla's existing fallback.
        }
        return null;
    }

    static ProfileResult ownProfile(UUID requested, String json) {
        try {
            if (json.length() > 96 * 1024) return null;
            JsonObject value = JsonParser.parseString(json).getAsJsonObject();
            String id = value.get("id").getAsString(), name = value.get("name").getAsString();
            if (!id.matches("[a-f0-9]{32}") || !id.equals(requested.toString().replace("-", ""))
                    || !name.matches("[A-Za-z0-9_]{1,16}")) return null;
            var properties = value.getAsJsonArray("properties");
            if (properties.size() != 1) return null;
            JsonObject texture = properties.get(0).getAsJsonObject();
            String propertyName = texture.get("name").getAsString();
            String packed = texture.get("value").getAsString(), signature = texture.get("signature").getAsString();
            if (!propertyName.equals("textures") || packed.isEmpty() || packed.length() > 65536
                    || signature.isEmpty() || signature.length() > 8192) return null;
            var map = ArrayListMultimap.<String, Property>create();
            map.put("textures", new Property("textures", packed, signature));
            // Loading properties does not promote their signature state. The
            // existing unpackTextures path still verifies the signed payload.
            return new ProfileResult(new GameProfile(requested, name, new PropertyMap(map)));
        } catch (RuntimeException malformed) { return null; }
    }

    private static SessionService textureGsonService;

    private static synchronized void prepareTextureGson(SessionService service) {
        if (textureGsonService == service || !(service instanceof MinecraftServicesSessionService)) return;
        try {
            // Gson otherwise allocates this constructor-only authlib value with
            // sun.misc.Unsafe, whose facade is absent from the portable runtime.
            // Keep the original Gson adapters and reflective field population.
            var field = MinecraftServicesSessionService.class.getDeclaredField("gson");
            field.setAccessible(true);
            Gson original = (Gson) field.get(service);
            InstanceCreator<MinecraftProfileTexture> creator =
                    type -> new MinecraftProfileTexture(null, null);
            field.set(service, original.newBuilder()
                    .registerTypeAdapter(MinecraftProfileTexture.class, creator).create());
            textureGsonService = service;
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("Player texture JSON allocation is unavailable", failure);
        }
    }

    public static MinecraftProfileTextures unpackTextures(SessionService service, Property property) {
        prepareTextureGson(Objects.requireNonNull(service));
        // Keep authlib's base64/JSON parsing and discovery-domain validation.
        MinecraftProfileTextures textures = service.unpackTextures(property);
        if (textures == null || textures.signatureState() != SignatureState.INVALID
                || property == null || !property.hasSignature() || !"textures".equals(property.name())
                || property.value().length() > 65536 || property.signature().length() > 8192) return textures;
        HttpURLConnection connection = null;
        try {
            // This URL is an internal transport operation, intercepted by the
            // GPU worker. It is never fetched: the worker POSTs the property to
            // the authenticated same-origin verifier without exposing a token.
            String operation = "https://mcweb-profile-verifier.invalid/verify?value="
                    + URLEncoder.encode(property.value(), StandardCharsets.UTF_8)
                    + "&signature=" + URLEncoder.encode(property.signature(), StandardCharsets.UTF_8);
            connection = (HttpURLConnection) BrowserPackHttp.openConnection(new URL(operation), Proxy.NO_PROXY);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            if (connection.getResponseCode() != 200) return textures;
            try (InputStream input = connection.getInputStream()) {
                // Exact one-byte response; errors, malformed replies and failed
                // signatures retain authlib's INVALID state.
                if (input.read() != 1 || input.read() != -1) return textures;
            }
            System.out.println("[player-textures] signed profile verified");
            return new MinecraftProfileTextures(textures.skin(), textures.cape(), textures.elytra(), SignatureState.SIGNED);
        } catch (Exception failure) {
            System.err.println("[player-textures] profile verification unavailable; keeping invalid signature state");
            return textures;
        } finally { if (connection != null) connection.disconnect(); }
    }
}
