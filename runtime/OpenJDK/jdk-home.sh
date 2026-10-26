# Sourced by the build scripts (needs HERE = this directory): picks the host
# JDK 25 into BOOT_JDK unless the caller set one. Temurin first: GraalVM's
# javac has an org.graalvm.webimage.api module that clashes with the port's
# shim, so a GraalVM JAVA_HOME is the last resort, not the first.
if [ -z "${BOOT_JDK:-}" ]; then
  for c in "$HERE/work/temurin25" /opt/homebrew/opt/openjdk@25 /opt/jdk25 "${JAVA_HOME:-}"; do
    if [ -n "$c" ] && [ -x "$c/bin/javac" ]; then BOOT_JDK=$c; break; fi
  done
fi
[ -n "${BOOT_JDK:-}" ] && [ -x "$BOOT_JDK/bin/javac" ] \
  || { echo "no JDK 25 found: set BOOT_JDK (OpenJDK/work/temurin25 is the default)" >&2; exit 1; }
