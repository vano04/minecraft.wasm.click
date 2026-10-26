#!/usr/bin/env node
// Desktop touch/viewport regression; a physical on-screen keyboard is a separate check.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || new URL('../runtime/node_modules/playwright/index.mjs',import.meta.url).href);
import {testDisplay} from '../runtime/tools/test-display.mjs';
import {keyboardGameControls} from '../server/runtime-fixes.mjs';

const assets=new Map();
for(const name of ['game-controls.js','game-controls.css']) {
  const body=await readFile(new URL('../runtime/web/'+name,import.meta.url),'utf8');
  assets.set('/'+name,name==='game-controls.js'?keyboardGameControls(body):body);
}
assets.set('/text-input-check.html',"<!doctype html>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>MC-Web native keyboard check</title>\n<!-- Isolation page for tests/text-input.spec.ts: the production controls\n     module (game-controls.js) with a stand-in GPU Worker. The test plays the\n     game's side (text-input reports, as webgpu-host.js posts them) and reads\n     back exactly what the page would have sent to the game. -->\n<link rel=\"stylesheet\" href=\"game-controls.css\">\n<style>\n  body { margin: 0; font: 14px system-ui, sans-serif; }\n  #launcher-name { margin: 8px; }\n  #stage { width: 640px; }\n  #game-canvas { display: block; width: 640px; height: 360px; background: #223; }\n</style>\n<input id=\"launcher-name\" aria-label=\"Launcher field\" value=\"\">\n<div id=\"stage\"><canvas id=\"game-canvas\" class=\"on\" width=\"1280\" height=\"720\"></canvas></div>\n<script src=\"game-controls.js\"></script>\n<script>\n  \"use strict\";\n  // The GPU Worker as the page sees it: postMessage out, \"message\" events in.\n  class StandInWorker extends EventTarget {\n    constructor() { super(); this.posted = []; }\n    postMessage(message) { this.posted.push(structuredClone(message)); }\n  }\n  const worker = new StandInWorker();\n  globalThis.__mcWebGpuWorker = worker;\n  // A visual viewport the test can shrink and pan the way an on-screen\n  // keyboard does: offsetTop is where the visible band starts inside the\n  // layout viewport, in the client coordinates getBoundingClientRect uses.\n  const viewport = new EventTarget();\n  viewport.offsetTop = 0;\n  viewport.offsetLeft = 0;\n  viewport.width = innerWidth;\n  viewport.height = innerHeight;\n  viewport.scale = 1;\n  globalThis.visualViewport = viewport;\n\n  const controls = mcWebGameControls.create({\n    container: document.getElementById(\"stage\"),\n    getCanvas: () => document.querySelector(\"#game-canvas.on\"),\n    touchMode: \"on\",\n  });\n  // Seen by a window listener that runs after the controls' capture-phase\n  // touchend handler: proves the focus happened inside the touch gesture.\n  const focusAtTouchEnd = [];\n  addEventListener(\"touchend\", () => {\n    focusAtTouchEnd.push(document.activeElement?.className || document.activeElement?.tagName || null);\n  });\n  globalThis.textCheck = {\n    worker,\n    controls,\n    focusAtTouchEnd,\n    report(state) {\n      worker.dispatchEvent(new MessageEvent(\"message\", { data: { mcwebTextInput: state } }));\n    },\n    grab(wanted) {\n      worker.dispatchEvent(new MessageEvent(\"message\", { data: { mcwebCursorWanted: wanted } }));\n    },\n    keyboard(height, offsetTop = 0) {\n      viewport.height = height;\n      viewport.offsetTop = offsetTop;\n      viewport.dispatchEvent(new Event(\"resize\"));\n    },\n    texts() { return worker.posted.filter((m) => m.mcwebText).map((m) => m.mcwebText); },\n    keys() {\n      return worker.posted.filter((m) => m.mcwebDom && m.mcwebDom.type.startsWith(\"key\"))\n        .map((m) => m.mcwebDom.type + \":\" + m.mcwebDom.init.code);\n    },\n    clear() { worker.posted.length = 0; focusAtTouchEnd.length = 0; },\n    proxyFocused() { return document.activeElement === document.querySelector(\".mcweb-gc-text-proxy\"); },\n  };\n</script>\n");
const server=createServer((request,response)=>{
  const body=assets.get(request.url);
  if(body===undefined){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',request.url.endsWith('.js')?'text/javascript':request.url.endsWith('.css')?'text/css':'text/html');response.end(body);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const display=testDisplay();
const browser=await chromium.launch({headless:false,executablePath:process.env.CHROME_PATH||chromium.executablePath(),env:display.env,args:display.args});
try {
  for(const viewport of [{width:700,height:460},{width:844,height:390}]) {
    const page=await browser.newPage({hasTouch:true,viewport});
    await page.goto('http://127.0.0.1:'+server.address().port+'/text-input-check.html');
    await page.waitForFunction(()=>textCheck.worker.posted.some(value=>value.mcwebTextInputQuery));
    const boxes=()=>page.evaluate(()=>{
      const canvas=document.querySelector('#game-canvas').getBoundingClientRect(),overlay=document.querySelector('.mcweb-gc-root').getBoundingClientRect();
      return {canvasTop:canvas.top,overlayTop:overlay.top,canvasHeight:canvas.height,overlayHeight:overlay.height};
    });
    const baseline=await page.locator('#game-canvas').boundingBox();
    for(const close of ['blur','game-report']) {
      await page.evaluate(()=>{
        textCheck.controls.setReady(true);textCheck.grab(false);
        textCheck.report({active:true,owner:'widget',area:{x:408,y:306,w:2,h:20},fields:[{x:400,y:300,w:480,h:40,focused:true}]});
      });
      const canvas=await page.locator('#game-canvas').boundingBox();
      await page.touchscreen.tap(canvas.x+205,canvas.y+155);
      await page.waitForFunction(()=>textCheck.proxyFocused());
      await page.evaluate(()=>{
        textCheck.keyboard(150,20);
        for(let i=0;i<5;i++)dispatchEvent(new Event('resize'));
      });
      const shifted=await boxes();assert.ok(shifted.canvasTop<baseline.y);
      assert.equal(shifted.overlayTop,shifted.canvasTop,'Controls must share the canvas shift exactly once');
      if(close==='blur')await page.evaluate(()=>document.querySelector('.mcweb-gc-text-proxy').blur());
      else await page.evaluate(()=>textCheck.report({active:false,fields:[]}));
      await page.waitForFunction(()=>textCheck.controls.getState().keyboard==='closed');
      // The visual viewport can finish its resize after the textarea blurs.
      await page.evaluate(()=>{textCheck.keyboard(innerHeight);dispatchEvent(new Event('resize'));});
      const restored=await boxes();assert.equal(restored.canvasTop,baseline.y);assert.equal(restored.overlayTop,baseline.y);
      assert.equal(restored.canvasHeight,baseline.height);assert.equal(restored.overlayHeight,baseline.height);
      await page.evaluate(()=>{textCheck.report({active:false,fields:[]});textCheck.grab(true);textCheck.clear();});
      await page.getByRole('button',{name:'Open or close inventory',exact:true}).tap();
      assert.ok((await page.evaluate(()=>textCheck.keys())).includes('keydown:KeyE'),'Restored controls must still deliver input');
    }
    await page.close();
  }
  console.log('PASS touch keyboard layout: two landscape viewports, repeated resize while shifted, blur and game close, delayed viewport restore, inventory input');
} finally {await browser.close();server.close();}
