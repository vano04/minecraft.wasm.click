package dev.mcweb.graal;

import com.mojang.blaze3d.platform.TextInputManager;
import com.mojang.blaze3d.platform.Window;
import dev.mcweb.graal.webgpu.BrowserGpu;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.events.ContainerEventHandler;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.recipebook.RecipeBookComponent;

/**
 * Tells the page which text input the game wants, so a touch screen can open
 * its native keyboard.
 *
 * <p>iOS opens the keyboard only for a field focused inside the user's tap,
 * and the game hears about that tap a frame or more later, on another thread.
 * So the page must already know, when the finger lifts, whether it is over a
 * text field. Each frame, after the event loop has drained, this reports:</p>
 * <ul>
 *   <li>whether text input is started ({@code SDL_StartTextInput} /
 *       {@code SDL_StopTextInput}, which Mojang's {@code TextInputManager}
 *       calls as a field gains and loses focus), and what owns it: a widget,
 *       or a screen that edits text without one (the sign editor);</li>
 *   <li>the caret rectangle from {@code SDL_SetTextInputArea};</li>
 *   <li>the rectangles of the editable text fields on the current screen:
 *       the visible, active {@link EditBox} and {@link MultiLineEditBox}
 *       widgets among its children, the recipe book's search box, which is
 *       not one of them, and the widget that owns text input; the owner is
 *       marked.</li>
 * </ul>
 * <p>All rectangles are canvas pixels. A report is sent only when one of them
 * changed, so a still screen costs one short walk of its widget tree and no
 * host traffic.</p>
 *
 * <p>Three private members have no public accessor and are read by
 * reflection, resolved once: {@code TextInputManager.owner} (what text input
 * belongs to), {@code EditBox.isEditable} (a read-only box is not a field to
 * type into) and {@code RecipeBookComponent.searchBox}; the names are those of
 * the pinned 26.3 jar. If one is missing the census says so once, in a
 * {@code text-input-census: reflection unavailable} progress line, and leaves
 * out what it cannot know instead of guessing: without the owner, fields are
 * marked by focus, no screen is treated as an editor and no unlisted owner is
 * added; without editability, an {@link EditBox} is listed only as the known
 * owner of text input (owning it means the game takes its typing); without
 * the search-box field, the recipe book's box is listed only as the known
 * owner.</p>
 *
 * <p>The report rides the existing progress channel
 * ({@link BrowserGpu#reportProgress}) as an {@code evt:} marker, which the
 * OpenJDK lane's RPC client already defers onto the next request: no new
 * {@code @JS} method, so the bridge library and the linked runtime stay as
 * they are. {@code webgpu-host.js} takes the marker before its stage ring and
 * hands the state to the page.</p>
 */
public final class BrowserTextInput {
    /** The host recognises reports by this prefix (webgpu-host.js). */
    public static final String PREFIX = "evt:text-input ";
    /** Owner kinds in a report: none or unknown, a widget, a screen without one. */
    private static final int OWNER_OTHER = 0;
    private static final int OWNER_WIDGET = 1;
    private static final int OWNER_SCREEN = 2;
    private static final int MAX_FIELDS = 16;
    private static final int MAX_DEPTH = 6;
    /** Per field: x, y, width, height, owns text input. */
    private static final int STRIDE = 5;

    private static final Field TEXT_INPUT_OWNER = field(TextInputManager.class, "owner");
    private static final Field EDIT_BOX_EDITABLE = field(EditBox.class, "isEditable");
    private static final Field RECIPE_BOOK_SEARCH = field(RecipeBookComponent.class, "searchBox");

    private static boolean active;
    private static boolean hasArea;
    private static int areaX;
    private static int areaY;
    private static int areaW;
    private static int areaH;

    private static final int[] fields = new int[MAX_FIELDS * STRIDE];
    private static int fieldCount;
    private static int ownerKind;
    /** The census's view of TextInputManager.owner, or null when unknown. */
    private static Object owner;
    /** The walk reached the owner: listed, or left out because it is clipped or hidden. */
    private static boolean ownerVisited;
    private static final int[] sentFields = new int[MAX_FIELDS * STRIDE];
    private static int sentFieldCount = -1;
    private static int sentOwnerKind;
    private static boolean sentActive;
    private static boolean sentHasArea;
    private static int sentAreaX;
    private static int sentAreaY;
    private static int sentAreaW;
    private static int sentAreaH;
    /** A census that threw once is not retried; the SDL state is still reported. */
    private static boolean censusFailed;
    private static boolean reflectionReported;

    private BrowserTextInput() {
    }

    private static Field field(Class<?> type, String name) {
        try {
            Field found = type.getDeclaredField(name);
            found.setAccessible(true);
            return found;
        } catch (ReflectiveOperationException | RuntimeException unavailable) {
            return null;
        }
    }

    public static void started() {
        active = true;
    }

    public static void stopped() {
        active = false;
    }

    public static void area(int x, int y, int width, int height) {
        hasArea = true;
        areaX = x;
        areaY = y;
        areaW = width;
        areaH = height;
    }

    public static void clearArea() {
        hasArea = false;
    }

    /** Once per frame, on the game thread, after its event loop drained the queue. */
    public static void publish() {
        fieldCount = 0;
        ownerKind = OWNER_OTHER;
        if (!censusFailed) {
            try {
                census();
            } catch (Throwable failure) {
                censusFailed = true;
                fieldCount = 0;
                ownerKind = OWNER_OTHER;
                BrowserGpu.reportJavaFailure("text-input-census", failure.getClass().getName(),
                        failure.getMessage() == null ? "" : failure.getMessage());
            }
        }
        boolean areaShown = active && hasArea;
        if (sentFieldCount == fieldCount && sentActive == active && sentOwnerKind == ownerKind
                && sentHasArea == areaShown
                && (!areaShown || (sentAreaX == areaX && sentAreaY == areaY
                        && sentAreaW == areaW && sentAreaH == areaH))
                && Arrays.equals(fields, 0, fieldCount * STRIDE, sentFields, 0, fieldCount * STRIDE)) {
            return;
        }
        sentFieldCount = fieldCount;
        sentActive = active;
        sentOwnerKind = ownerKind;
        sentHasArea = areaShown;
        sentAreaX = areaX;
        sentAreaY = areaY;
        sentAreaW = areaW;
        sentAreaH = areaH;
        System.arraycopy(fields, 0, sentFields, 0, fieldCount * STRIDE);
        // evt:text-input <active> <owner kind> <caret x y w h, or -1 -1 0 0> <n>
        //                then n times x y w h owner
        StringBuilder line = new StringBuilder(PREFIX.length() + 28 + fieldCount * 24).append(PREFIX)
                .append(active ? 1 : 0).append(' ').append(ownerKind).append(' ');
        if (areaShown) {
            line.append(areaX).append(' ').append(areaY).append(' ')
                    .append(areaW).append(' ').append(areaH);
        } else {
            line.append("-1 -1 0 0");
        }
        line.append(' ').append(fieldCount);
        for (int i = 0; i < fieldCount * STRIDE; i++) {
            line.append(' ').append(fields[i]);
        }
        BrowserGpu.reportProgress(line.toString());
    }

    private static void census() throws IllegalAccessException {
        if (!reflectionReported) {
            reflectionReported = true;
            if (TEXT_INPUT_OWNER == null || EDIT_BOX_EDITABLE == null || RECIPE_BOOK_SEARCH == null) {
                BrowserGpu.reportProgress("text-input-census: reflection unavailable owner="
                        + (TEXT_INPUT_OWNER != null) + " editable=" + (EDIT_BOX_EDITABLE != null)
                        + " recipeSearch=" + (RECIPE_BOOK_SEARCH != null));
            }
        }
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft == null) {
            return;
        }
        Gui gui = minecraft.gui;
        Window window = minecraft.getWindow();
        TextInputManager manager = minecraft.textInputManager();
        if (gui == null || window == null || manager == null) {
            return;
        }
        owner = active && TEXT_INPUT_OWNER != null ? TEXT_INPUT_OWNER.get(manager) : null;
        if (owner instanceof AbstractWidget) {
            ownerKind = OWNER_WIDGET;
        } else if (owner instanceof Screen) {
            ownerKind = OWNER_SCREEN;
        }
        ownerVisited = false;
        Screen screen = gui.screen();
        if (screen == null || gui.overlay() != null) {
            return;
        }
        int scale = Math.max(1, window.getGuiScale());
        visit(screen.children(), scale, Integer.MIN_VALUE, Integer.MIN_VALUE,
                Integer.MAX_VALUE, Integer.MAX_VALUE, 0, true);
        // A field that owns text input but is not reachable through children()
        // (the recipe book's search box when its field cannot be read). One
        // the walk reached and left out (scrolled away, hidden) stays out.
        if (owner instanceof AbstractWidget widget && !ownerVisited && widget.isActive()) {
            add(widget, scale, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE);
        }
    }

    /**
     * Clip bounds are GUI units; a scrolled list clips the fields inside it.
     * {@code listing} false walks a hidden or fully clipped container only to
     * find the owner, so it is not then added at its unclipped position.
     */
    private static void visit(List<? extends GuiEventListener> children, int scale,
            int clipLeft, int clipTop, int clipRight, int clipBottom, int depth, boolean listing)
            throws IllegalAccessException {
        for (int i = 0, n = children.size(); i < n; i++) {
            GuiEventListener child = children.get(i);
            if (child == owner) {
                ownerVisited = true;
            }
            if (!listing) {
                if (ownerVisited) {
                    return;
                }
                if (depth < MAX_DEPTH && child instanceof ContainerEventHandler container) {
                    visit(container.children(), scale, clipLeft, clipTop, clipRight, clipBottom, depth + 1, false);
                }
                continue;
            }
            if (child instanceof EditBox box) {
                // The owner takes typing, so it needs no editability read.
                if (box.isActive() && (box == owner || editable(box))) {
                    add(box, scale, clipLeft, clipTop, clipRight, clipBottom);
                }
            } else if (child instanceof MultiLineEditBox area) {
                if (area.isActive()) {
                    add(area, scale, clipLeft, clipTop, clipRight, clipBottom);
                }
            } else if (child instanceof RecipeBookComponent<?> book) {
                if (RECIPE_BOOK_SEARCH != null && RECIPE_BOOK_SEARCH.get(book) instanceof EditBox search) {
                    if (search == owner) {
                        ownerVisited = true;
                    }
                    if (book.isVisible() && search.isActive() && (search == owner || editable(search))) {
                        add(search, scale, clipLeft, clipTop, clipRight, clipBottom);
                    }
                }
            } else if (depth < MAX_DEPTH && child instanceof ContainerEventHandler container) {
                int left = clipLeft;
                int top = clipTop;
                int right = clipRight;
                int bottom = clipBottom;
                boolean shown = true;
                if (child instanceof AbstractWidget widget) {
                    left = Math.max(left, widget.getX());
                    top = Math.max(top, widget.getY());
                    right = Math.min(right, widget.getX() + widget.getWidth());
                    bottom = Math.min(bottom, widget.getY() + widget.getHeight());
                    shown = widget.visible && right > left && bottom > top;
                }
                if (shown) {
                    visit(container.children(), scale, left, top, right, bottom, depth + 1, true);
                } else if (!ownerVisited && owner instanceof AbstractWidget) {
                    visit(container.children(), scale, left, top, right, bottom, depth + 1, false);
                }
            }
        }
    }

    /** Unknown editability is not editable: a read-only box must never open the keyboard. */
    private static boolean editable(EditBox box) throws IllegalAccessException {
        return EDIT_BOX_EDITABLE != null && EDIT_BOX_EDITABLE.getBoolean(box);
    }

    private static void add(AbstractWidget widget, int scale,
            int clipLeft, int clipTop, int clipRight, int clipBottom) {
        // Without the owner (reflection unavailable) focus is the best signal.
        boolean owns = TEXT_INPUT_OWNER != null ? active && widget == owner : widget.isFocused();
        if (owns) {
            ownerVisited = true;
        }
        int left = Math.max(clipLeft, widget.getX());
        int top = Math.max(clipTop, widget.getY());
        int right = Math.min(clipRight, widget.getX() + widget.getWidth());
        int bottom = Math.min(clipBottom, widget.getY() + widget.getHeight());
        if (right <= left || bottom <= top) {
            return;
        }
        int slot = fieldCount;
        if (slot >= MAX_FIELDS) {
            // Full: the owner still gets a slot, the last non-owner's. There
            // is at most one owner, so the last slot is never it.
            if (!owns) {
                return;
            }
            slot = MAX_FIELDS - 1;
        } else {
            fieldCount++;
        }
        int at = slot * STRIDE;
        fields[at] = left * scale;
        fields[at + 1] = top * scale;
        fields[at + 2] = (right - left) * scale;
        fields[at + 3] = (bottom - top) * scale;
        fields[at + 4] = owns ? 1 : 0;
    }
}
