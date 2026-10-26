package dev.mcweb.graal;

import com.mojang.authlib.services.MinecraftServicesDiscoveryService;
import com.mojang.renderpearl.api.device.BackendCreationException;
import java.net.Proxy;
import java.util.List;

/**
 * Redirect targets for the three boot steps 26.3 added that a browser page
 * cannot take (tools/wasmjvm-massage-plan.mjs). Each replaces one call site;
 * the surrounding Mojang code runs as shipped.
 */
public final class BrowserBootCompat {
    private BrowserBootCompat() {
    }

    /**
     * {@code SdlDebug.init} in {@code RenderSystem.initBackendSystem}: it hands
     * SDL a log callback, an LWJGL upcall, which this runtime cannot create
     * (the same failure the GameRenderer screenshot stub avoids). There is no
     * native SDL here to log anything.
     */
    public static void sdlDebugInit() {
    }

    /**
     * {@code VulkanFeatureSets.bootstrap} in {@code ClientBootstrap.bootstrap}:
     * it lays out Vulkan feature structs for the desktop Vulkan backend, which
     * the browser never selects.
     */
    public static void vulkanFeatureSetsBootstrap() {
    }

    /**
     * {@code VulkanBackend.checkBackendAvailable} in {@code Minecraft.<init>}:
     * the probe loads the Vulkan loader through SDL. Report what it would find.
     */
    public static BackendCreationException vulkanUnavailable() {
        return new BackendCreationException(
                "Desktop Vulkan is replaced by browser WebGPU",
                BackendCreationException.Reason.VULKAN_LOADER_MISSING,
                List.of()
        );
    }

    /**
     * {@code MinecraftServicesDiscoveryService.create(Proxy, boolean)} in
     * {@code Minecraft.<init>}: authlib 10 fetches its service discovery
     * document at once, from a page that has no account to sign in with. The
     * port's discovery is offline apart from the skin texture host.
     */
    public static MinecraftServicesDiscoveryService servicesDiscovery(Proxy proxy, boolean online) {
        return BrowserSkinTextureCompat.servicesDiscovery(proxy);
    }
}
