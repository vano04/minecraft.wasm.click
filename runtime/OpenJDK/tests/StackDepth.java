/** Stack traces through nested calls, own thread and another thread's. */
public class StackDepth {
    static int depthHere(int n) { return n == 0 ? Thread.currentThread().getStackTrace().length : depthHere(n - 1); }
    static int depthEx(int n) { return n == 0 ? new Throwable().getStackTrace().length : depthEx(n - 1); }
    public static void main(String[] a) throws Exception {
        int reps = a.length > 0 ? Integer.parseInt(a[0]) : 5000;
        int d1 = 0, d2 = 0;
        for (int i = 0; i < reps; i++) { d1 = depthHere(10); d2 = depthEx(10); }
        Object lock = new Object();
        Thread t = new Thread(() -> { synchronized (lock) { try { lock.wait(); } catch (InterruptedException e) {} } });
        t.start(); Thread.sleep(200);
        int d3 = Thread.getAllStackTraces().get(t).length;
        synchronized (lock) { lock.notifyAll(); }
        t.join();
        System.out.println("stackdepth getStackTrace=" + d1 + " throwable=" + d2 + " otherThread=" + d3);
    }
}
