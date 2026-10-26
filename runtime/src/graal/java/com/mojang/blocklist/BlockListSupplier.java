package com.mojang.blocklist;

import java.util.function.Predicate;

/**
 * MC-Web's own stand-in for the service interface Minecraft's
 * {@code AddressCheck} looks up with {@link java.util.ServiceLoader}. Mojang's
 * blocklist and patchy libraries are only published on
 * libraries.minecraft.net, which a web page cannot read, so no provider is
 * present in the browser and AddressCheck takes its no-provider path.
 */
public interface BlockListSupplier {
    Predicate<String> createBlockList();
}
