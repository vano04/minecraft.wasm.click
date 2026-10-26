package dev.mcweb.graal.webgpu;

import com.mojang.renderpearl.backend.api.BackendRenderPipeline;

/**
 * Handle to a GPURenderPipeline created by the browser host. Handle 0 means
 * the host rejected the pipeline; draws with it are skipped, as 26.2's
 * invalid pipelines were.
 */
final class WebGpuCompiledPipeline implements BackendRenderPipeline {
    private final int handle;

    /**
     * Binding names by the uniform index the frontend render pass passes to
     * setUniform(int, Object): the pipeline's flattened bind-group layout
     * order, the same list WebGpuDevice builds its uniformIndices from. The
     * host protocol stays name-based.
     */
    private final String[] uniformNames;
    private boolean closed;

    WebGpuCompiledPipeline(int handle, String[] uniformNames) {
        this.handle = handle;
        this.uniformNames = uniformNames;
    }

    int handle() {
        return handle;
    }

    boolean isValid() {
        return handle != 0;
    }

    String uniformName(int index) {
        return uniformNames[index];
    }

    /**
     * The host's interned id for a uniform index's binding name
     * (BrowserGpu.bindingNameId), looked up once per pipeline and index: the
     * render pass binds by it on every setUniform, which used to hash the
     * name into two HashMaps per call.
     */
    private int[] uniformIds;

    int uniformId(int index) {
        int[] ids = uniformIds;
        if (ids == null) {
            ids = new int[uniformNames.length];
            java.util.Arrays.fill(ids, -1);
            uniformIds = ids;
        }
        int id = ids[index];
        if (id < 0) {
            id = BrowserGpu.bindingNameId(uniformNames[index]);
            ids[index] = id;
        }
        return id;
    }

    @Override
    public boolean isClosed() {
        return closed;
    }

    @Override
    public void close() {
        if (!closed) {
            closed = true;
            if (handle != 0) {
                BrowserGpu.destroyObject(handle);
            }
        }
    }
}
