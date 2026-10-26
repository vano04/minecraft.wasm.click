// The host JDK 25 for tools that run javac or java, chosen the way
// OpenJDK/jdk-home.sh chooses it for the shell builds: $BOOT_JDK if set,
// else OpenJDK/work/temurin25, the Homebrew JDK, /opt/jdk25, then
// $JAVA_HOME. GraalVM's javac clashes with the port's shim, which is why a
// GraalVM JAVA_HOME is the last resort, not the first.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

const runnable = (home) => {
  try {
    accessSync(join(home, "bin", "javac"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The JDK home directory; throws, naming BOOT_JDK, when there is none. */
export function hostJdk(projectRoot) {
  const candidates = process.env.BOOT_JDK
    ? [process.env.BOOT_JDK]
    : [join(projectRoot, "OpenJDK", "work", "temurin25"), "/opt/homebrew/opt/openjdk@25", "/opt/jdk25",
      process.env.JAVA_HOME];
  const home = candidates.find((c) => c && runnable(c));
  if (!home) throw new Error("no JDK 25 found: set BOOT_JDK (OpenJDK/work/temurin25 is the default)");
  return home;
}
