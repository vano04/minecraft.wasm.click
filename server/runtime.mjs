export function webkitRuntimePage(html) {
  const argumentsList = "['-XX:+UnlockExperimentalVMOptions', '-XX:+UseZeroWasmJIT']";
  const marker = "...(on('nojit') ? [] : " + argumentsList + ")";
  if (html.split(marker).length !== 2) throw Error('Unexpected runtime launch arguments');
  return html.replace(marker, "'-Dmcweb.noblur=1', ...(on('nojit') ? [] : "
    + argumentsList.slice(0, -1) + ", '-XX:ZeroWasmJITOnly=net.minecraft'])");
}

export function isWebKit(request) {
  const agent = request.headers['user-agent'] || '';
  return /AppleWebKit\//.test(agent) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(agent);
}
