// Minimal harness pre-js: what browser/pre.js does before main, and nothing of
// the MC-Web seams (no WebGPU, no payload, no bridge library).
if (typeof ENVIRONMENT_IS_NODE === 'undefined' || !ENVIRONMENT_IS_NODE) {
  Module.thisProgram = '/jdk/bin/javalauncher';
}
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  if ((typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD)
      || (typeof ENVIRONMENT_IS_NODE !== 'undefined' && ENVIRONMENT_IS_NODE)) return;
  FS.chdir('/jdk/bin');
  FS.writeFile('/jdk/bin/javalauncher', 'argv[0] marker\n');
  FS.chmod('/jdk/bin/javalauncher', 0o755);
});
