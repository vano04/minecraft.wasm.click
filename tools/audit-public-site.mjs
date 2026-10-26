#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { publicSourceInventory } from './public-source.mjs';
import { verifyRuntimeSource } from './verify-runtime-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSource = await verifyRuntimeSource({root,checkGit:false,requireReleaseMatch:true});
const entries = await publicSourceInventory(root);
console.log(JSON.stringify({schema:1,kind:'minecraft-wasm-click-public-source',runtimeSource,
  sourceSha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  totalBytes:entries.reduce((sum,file)=>sum+file.bytes,0),entries},null,2));
