#!/usr/bin/env node
// Applies the in-tab patch plan (tools/wasmjvm-massage-plan.mjs) to Mojang's
// client jar exactly as the page does (OpenJDK/browser/jar-massage.js), writes
// the result, and has HotSpot link every patched class with full bytecode
// verification against the port and Minecraft's libraries -- the check a
// browser run would otherwise make one five-minute boot at a time.
//
//   node tools/verify-massaged-jar.mjs [--jar ~/.minecraft/versions/26.3/26.3.jar]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { MASSAGE_PLAN } from "./wasmjvm-massage-plan.mjs";
import { jarTools } from "./wasmjvm-provenance.mjs";
import { hostJdk } from "./host-jdk.mjs";
import { MC_VERSION } from "./mc-version.mjs";

const PROJECT = new URL("..", import.meta.url).pathname;
const opt = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const jarPath = opt("jar", join(homedir(), ".minecraft", "versions", MC_VERSION, `${MC_VERSION}.jar`));
const java = join(hostJdk(PROJECT), "bin");
const tools = jarTools(PROJECT);
const result = await tools.prepareClientJar(new Uint8Array(readFileSync(jarPath)), MASSAGE_PLAN);
if (result.missing.length) throw new Error("plan names entries the jar lacks: " + result.missing.join(", "));
const out = join(PROJECT, "build", "verify");
mkdirSync(join(out, "src"), { recursive: true });
writeFileSync(join(out, "massaged.jar"), result.bytes);
console.log(`patched ${result.patched.length} classes: ${result.patched.join(", ")}`);

writeFileSync(join(out, "src", "VerifyCheck.java"), `
public class VerifyCheck {
  public static void main(String[] names) throws Exception {
    int bad = 0;
    for (String n : names) {
      String cls = n.replace('/', '.').replaceAll("\\\\.class$", "");
      try {
        Class.forName(cls, true, VerifyCheck.class.getClassLoader());
        System.out.println("ok      " + cls);
      } catch (VerifyError | ClassFormatError | IncompatibleClassChangeError e) {
        bad++;
        System.out.println("INVALID " + cls + ": " + e);
      } catch (Throwable e) {
        // Linked (so verified); its static initialiser wants a running game.
        System.out.println("ok      " + cls + " (verified; init: " + e.getClass().getSimpleName() + ")");
      }
    }
    System.exit(bad == 0 ? 0 : 1);
  }
}`);
execFileSync(join(java, "javac"), ["-d", join(out, "classes"), join(out, "src", "VerifyCheck.java")]);
const libs = join(PROJECT, "build", `wasmjvm-libraries-${MC_VERSION}`);
const cp = [join(out, "classes"), join(out, "massaged.jar"), join(PROJECT, "OpenJDK", "mcweb", "mcweb-port.jar"),
  ...readdirSync(libs).filter((f) => f.endsWith(".jar")).map((f) => join(libs, f))].join(":");
try {
  const text = execFileSync(join(java, "java"), ["-Xverify:all", "-cp", cp, "VerifyCheck", ...result.patched],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(text);
} catch (e) {
  process.stdout.write(String(e.stdout || ""));
  process.stderr.write(String(e.stderr || "").slice(0, 2000));
  process.exit(1);
}
