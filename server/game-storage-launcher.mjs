// Keep the generated, checksum-pinned JVM payload unchanged. The authenticated
// launcher supplies this page-owned filesystem adapter before starting Java.
export function playerStorageTestingPage(html) {
  const launch = "    await createJavaVM({";
  const frameVariants = ["memoryBudgetMiB", "memoryWasmMaxMiB"]
    .map(name => "  const runtimeArgs = mobile.runtimeArguments(args, " + name + ");");
  const frameArgs = frameVariants.find(marker => html.includes(marker));
  if (frameVariants.reduce((count, marker) => count + html.split(marker).length - 1, 0) !== 1) {
    throw new Error("Unexpected player storage launcher hook: runtime memory arguments");
  }
  const terminalDeclaration = "let runtimeDiscardRequested = false;";
  const terminalAware = html.includes(terminalDeclaration);
  if (terminalAware && html.split(terminalDeclaration).length !== 2) throw new Error("Unexpected terminal launcher declaration");
  const terminalGuard = terminalAware ? "    if (runtimeDiscardRequested) return;\n" : "";
  const preRun = "      preRun: [(module) => {";
  for (const marker of [launch, preRun, frameArgs]) {
    if (html.split(marker).length !== 2) throw new Error("Unexpected player storage launcher hook: " + marker.trim());
  }
  return html.replace("<script>", '<script src="/auth/game-storage.js?v=20261022-framechoice2"></script><script src="/auth/own-profile.js?v=20261022-profile1"></script><script>')
    .replace(frameArgs, frameArgs + "\n  const frameArgsAt = runtimeArgs.indexOf('-cp');\n  if (frameArgsAt < 0 || runtimeArgs.lastIndexOf('-cp') !== frameArgsAt) throw new Error('Unexpected JVM classpath marker for saved frame options');\n  runtimeArgs.splice(frameArgsAt, 0, ...await globalThis.mcWebGameStorage.frameArguments(location.search));")
    .replace(launch, "    await globalThis.mcWebGameStorage.prepare();\n    await globalThis.mcWebOwnProfile.prepare(globalThis.__mcWebVerified?.session.profile);\n" + terminalGuard + launch)
    .replace(preRun, preRun + "\n        globalThis.mcWebGameStorage.attach(module);\n        globalThis.mcWebOwnProfile.attach(module);");
}
