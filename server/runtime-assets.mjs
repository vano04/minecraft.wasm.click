export function testingAssetResolver(source) {
  const marker = 'const response = await baseFetch(input, { cache: "no-store" });';
  if (source.split(marker).length !== 2) throw new Error('Unexpected asset resolver');
  // This rewrites browser JavaScript; the Worker never fetches these assets.
  // The browser verifies the response against Mojang's pinned asset index.
  return source.replace(marker, "const response = await baseFetch('https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/26.3/assets/' + name, { cache: 'no-store', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });");
}
