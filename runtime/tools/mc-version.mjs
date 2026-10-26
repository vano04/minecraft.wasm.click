// The one Minecraft version this branch targets, and the SHA-256 of Mojang's
// client jar for it. Every tool that needs to know the version imports it
// from here instead of restating a literal.
export const MC_VERSION = "26.3";
export const MC_CLIENT_SHA256 = "4508d006323f24fa02876310c192d739af56516eb259000ac50f0909a68c9a2d";
// The release network protocol of that version (SharedConstants'
// RELEASE_NETWORK_PROTOCOL_VERSION), for tools that speak to a server
// without the client.
export const MC_PROTOCOL_VERSION = 777;
