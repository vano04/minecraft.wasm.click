// Run the production sound facade against Minecraft's actual Options and sound
// instances. Only the browser-native sink is replaced for the host JVM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const java = process.env.BOOT_JDK ? join(process.env.BOOT_JDK, 'bin/java') : 'java';
const game = process.env.MCWEB_COMPILE_JAR || join(repo, 'build/massaged/minecraft-26.3-massaged.jar');
const libraries = process.env.MCWEB_LIBRARIES_DIR || join(repo, 'build/wasmjvm-libraries-26.3');
const packagedPort = process.env.MCWEB_TEST_PORT_JAR;
const port = packagedPort || [join(repo, 'OpenJDK/mcweb/mcweb-port.jar'),
  join(repo, '../site/testing/payload/jar/mcweb-port.jar')].find(existsSync);
const available = existsSync(game) && existsSync(libraries) && port;

const sink = String.raw`
package dev.mcweb.graal;
public final class BrowserAudio {
    public static final java.util.Map<String, Double> gains = new java.util.HashMap<>();
    public static String event, source;
    public static double volume, pitch, x, y, z;
    public static int listenerCalls;
    public static boolean failListener;
    public static double[] listenerPose;
    public static int playInstance(String name, String category, double v, double p, int loop) {
        event = name; source = category; volume = v; pitch = p; return 1;
    }
    public static void setCategoryVolume(String source, double volume) { gains.put(source, volume); }
    public static void positionInstance(int handle, double px, double py, double pz) { x=px; y=py; z=pz; }
    public static void setListenerPose(double x, double y, double z,
            double fx, double fy, double fz, double ux, double uy, double uz) {
        listenerCalls++;
        if (failListener) throw new IllegalStateException("audio host unavailable");
        listenerPose = new double[] { x, y, z, fx, fy, fz, ux, uy, uz };
    }
    public static void stopInstance(int handle) {}
    public static void stopAll() {}
    public static boolean isPlaying(int handle) { return true; }
}
`;

const fixture = String.raw`
package dev.mcweb.graal;
import java.lang.reflect.Field;
import java.util.EnumMap;
import net.minecraft.client.Camera;
import net.minecraft.client.OptionInstance;
import net.minecraft.client.Options;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.client.resources.sounds.SoundInstance;
import net.minecraft.client.sounds.SoundEngine;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.resources.Identifier;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import sun.misc.Unsafe;

public final class AudioSettingsBehavior {
    private static final Unsafe UNSAFE;
    static {
        try {
            Field field = Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
            UNSAFE = (Unsafe) field.get(null);
        } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    }
    private static void set(Object owner, String name, Object value) throws Exception {
        Field field = owner.getClass().getDeclaredField(name); field.setAccessible(true); field.set(owner,value);
    }
    // Avoid constructing a complete Minecraft client just to read its volume
    // options. The real Options getters and OptionInstance.get remain in use.
    private static Options options() throws Exception {
        Options options = (Options) UNSAFE.allocateInstance(Options.class);
        var volumes = new EnumMap<SoundSource, OptionInstance<Double>>(SoundSource.class);
        for (SoundSource source : SoundSource.values()) {
            @SuppressWarnings("unchecked")
            OptionInstance<Double> option = (OptionInstance<Double>) UNSAFE.allocateInstance(OptionInstance.class);
            set(option, "value", 1.0); volumes.put(source, option);
        }
        set(options, "soundSourceVolumes", volumes); return options;
    }
    private static void volume(Options options, SoundSource source, double value) throws Exception {
        set(options.getSoundSourceOptionInstance(source), "value", value);
    }
    private static void gain(SoundSource source, double expected) {
        Double actual = BrowserAudio.gains.get(source.getName());
        if (actual == null || Math.abs(actual-expected)>0.00001)
            throw new AssertionError(source+" gain expected "+expected+", got "+actual);
    }
    private static final class MovingCamera extends Camera {
        void pose(double x, double y, double z, float yaw, float pitch) throws Exception {
            setPosition(x,y,z); setRotation(yaw,pitch);
            Field initialized = Camera.class.getDeclaredField("initialized");
            initialized.setAccessible(true); initialized.setBoolean(this,true);
        }
    }
    private static void pose(SoundManager manager, MovingCamera camera, double... expected) {
        manager.updateSource(camera);
        if (BrowserAudio.listenerPose == null) throw new AssertionError("listener pose never reached the browser");
        for (int index=0; index<expected.length; index++) {
            if (Math.abs(BrowserAudio.listenerPose[index]-expected[index])>0.00001)
                throw new AssertionError("listener component "+index+" expected "+expected[index]
                    +", got "+BrowserAudio.listenerPose[index]);
        }
        var transform = manager.getListenerTransform();
        double[] javaPose = { transform.position().x,transform.position().y,transform.position().z,
            transform.forward().x,transform.forward().y,transform.forward().z,
            transform.up().x,transform.up().y,transform.up().z };
        if (!java.util.Arrays.equals(BrowserAudio.listenerPose,javaPose))
            throw new AssertionError("Java listener transform differs from delivered browser pose");
    }
    public static void main(String[] args) throws Exception {
        Options options = options();
        volume(options, SoundSource.MASTER, 0.5); volume(options, SoundSource.MUSIC, 0);
        SoundManager manager = new SoundManager(options);
        switch (args[0]) {
            case "saved" -> { gain(SoundSource.MASTER,0.5); gain(SoundSource.MUSIC,0); }
            case "sliders" -> {
                volume(options,SoundSource.MUSIC,0.3); manager.refreshCategoryVolume(SoundSource.MUSIC);
                gain(SoundSource.MUSIC,0.3);
                volume(options,SoundSource.MASTER,0); manager.refreshCategoryVolume(SoundSource.MASTER);
                gain(SoundSource.MASTER,0);
            }
            case "fade" -> {
                volume(options,SoundSource.MUSIC,0.4); manager.refreshCategoryVolume(SoundSource.MUSIC);
                manager.updateCategoryVolume(SoundSource.MUSIC,0.5f); gain(SoundSource.MUSIC,0.2);
                volume(options,SoundSource.MUSIC,0.1); manager.refreshCategoryVolume(SoundSource.MUSIC);
                gain(SoundSource.MUSIC,0.05);
                volume(options,SoundSource.MUSIC,0); manager.refreshCategoryVolume(SoundSource.MUSIC);
                manager.updateCategoryVolume(SoundSource.MUSIC,1); gain(SoundSource.MUSIC,0);
                manager.stop(); volume(options,SoundSource.MUSIC,0.4); manager.refreshCategoryVolume(SoundSource.MUSIC);
                gain(SoundSource.MUSIC,0.4);
            }
            case "block" -> {
                var sound = new SimpleSoundInstance(Identifier.withDefaultNamespace("block.stone.break"),
                    SoundSource.BLOCKS,0.8f,0.6f,RandomSource.create(123),false,0,
                    SoundInstance.Attenuation.LINEAR,100,64,100,false);
                if (manager.play(sound) != SoundEngine.PlayResult.STARTED) throw new AssertionError("block sound declined");
                if (!"minecraft:block.stone.break".equals(BrowserAudio.event)
                    || !SoundSource.BLOCKS.getName().equals(BrowserAudio.source)
                    || Math.abs(BrowserAudio.volume-0.8)>0.00001 || Math.abs(BrowserAudio.pitch-0.6)>0.00001
                    || BrowserAudio.x!=100 || BrowserAudio.y!=64 || BrowserAudio.z!=100)
                    throw new AssertionError("block sound did not reach the browser intact");
            }
            case "orientation" -> {
                MovingCamera camera = new MovingCamera();
                camera.pose(-1000,64.5,2000,0,0);
                pose(manager,camera,-1000,64.5,2000,0,0,1,0,1,0);
                for (float yaw : new float[] {90,180,-90}) {
                    Thread.sleep(60);
                    camera.pose(-1000,64.5,2000,yaw,0);
                    double fx = yaw==90 ? -1 : yaw==-90 ? 1 : 0;
                    double fz = yaw==180 ? -1 : 0;
                    pose(manager,camera,-1000,64.5,2000,fx,0,fz,0,1,0);
                }
                Thread.sleep(60);
                camera.pose(-1000,64.5,2000,0,90);
                pose(manager,camera,-1000,64.5,2000,0,-1,0,0,0,1);
                if (BrowserAudio.listenerCalls!=5) throw new AssertionError("rotation-only poses were suppressed");
            }
            case "listener-coalescing" -> {
                MovingCamera camera = new MovingCamera(); camera.pose(10,20,30,0,0);
                pose(manager,camera,10,20,30,0,0,1,0,1,0);
                manager.updateSource(camera);
                if (BrowserAudio.listenerCalls!=1) throw new AssertionError("unchanged camera sent a redundant pose");
                camera.pose(11,20,30,45,30); manager.updateSource(camera);
                camera.pose(12,21,31,90,0);
                Thread.sleep(60);
                pose(manager,camera,12,21,31,-1,0,0,0,1,0);
                if (BrowserAudio.listenerCalls!=2) throw new AssertionError("camera updates did not coalesce to latest pose");
                Thread.sleep(60); manager.updateSource(camera);
                if (BrowserAudio.listenerCalls!=2) throw new AssertionError("unchanged latest pose was re-sent");
            }
            case "listener-retry" -> {
                MovingCamera camera = new MovingCamera(); camera.pose(10,20,30,0,0);
                BrowserAudio.failListener = true; manager.updateSource(camera);
                BrowserAudio.failListener = false;
                pose(manager,camera,10,20,30,0,0,1,0,1,0);
                if (BrowserAudio.listenerCalls!=2) throw new AssertionError("failed listener delivery was cached");
            }
            case "listener-reset" -> {
                MovingCamera camera = new MovingCamera(); camera.pose(10,20,30,0,0);
                pose(manager,camera,10,20,30,0,0,1,0,1,0);
                manager.updateSource(null);
                pose(manager,camera,10,20,30,0,0,1,0,1,0);
                camera.reset(); manager.updateSource(camera); camera.pose(10,20,30,0,0);
                pose(manager,camera,10,20,30,0,0,1,0,1,0);
                MovingCamera next = new MovingCamera(); next.pose(10,20,30,0,0);
                pose(manager,next,10,20,30,0,0,1,0,1,0);
                manager.stop(); pose(manager,next,10,20,30,0,0,1,0,1,0);
                if (BrowserAudio.listenerCalls!=5) throw new AssertionError("camera/world reset retained a stale listener");
            }
            default -> throw new AssertionError(args[0]);
        }
    }
}
`;

test('audio settings, sound instances and camera poses reach the browser mixer', {
  skip: !available && !process.env.MCWEB_REQUIRE_GAME_TESTS && 'requires the local 26.3 compile jar, port jar and libraries',
}, async t => {
  assert.ok(available, 'local Minecraft compile inputs are required');
  const root = mkdtempSync(join(tmpdir(), 'mcweb-audio-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [
    ['BrowserAudio.java', sink], ['AudioSettingsBehavior.java', fixture],
    ['BrowserGpu.java', 'package dev.mcweb.graal.webgpu; public final class BrowserGpu { public static void reportProgress(String s) { System.err.println(s); } }'],
  ].map(([name, text]) => { const path = join(root,name); writeFileSync(path,text); return path; });
  const classpath = [port,game,...readdirSync(libraries).filter(name=>name.endsWith('.jar'))
    .map(name=>join(libraries,name))].join(delimiter);
  const compile = spawnSync(java, ['-m','jdk.compiler/com.sun.tools.javac.Main','-nowarn','-proc:none','-d',root,'-cp',classpath,
    ...(packagedPort ? [] : [join(repo,'src/graal/java/net/minecraft/client/sounds/SoundManager.java')]),
    ...files], { encoding:'utf8', timeout:60_000 });
  assert.equal(compile.status,0,`${compile.error || ''}\n${compile.stdout}\n${compile.stderr}`);
  for (const scenario of ['saved','sliders','fade','block','orientation','listener-coalescing','listener-retry','listener-reset']) await t.test(scenario, () => {
    const run = spawnSync(java,['-cp',[root,classpath].join(delimiter),'dev.mcweb.graal.AudioSettingsBehavior',scenario],
      { encoding:'utf8', timeout:30_000 });
    assert.equal(run.status,0,`${run.error || ''}\n${run.stdout}\n${run.stderr}`);
  });
});
