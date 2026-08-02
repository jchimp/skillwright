import type { Skill } from "./skills";
import { matchSkills, resolveSkillToken, skillSlug, tokenAtCursor } from "./skillref";

/** Rows shown in the `/` autocomplete before it starts scrolling. */
const MAX_SUGGESTIONS = 8;

/** Box and text metrics the caret mirror has to copy for its wrapping to match. */
const MIRROR_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
] as const;

/** Either kind of field the popup can attach to. */
type TextField = HTMLTextAreaElement | HTMLInputElement;

/**
 * Pixel position of a character offset inside a text field, relative to the
 * element's own top-left corner.
 *
 * A textarea exposes no caret geometry, so this measures an off-screen div that
 * mirrors the element's box and text metrics with a zero-width marker at the
 * offset. The text after the marker is included so line wrapping matches; for a
 * single-line `<input>` the mirror simply never wraps.
 *
 * @param el - the field to measure
 * @param index - character offset to locate
 * @returns caret left/top in pixels, plus the line height at that point
 */
function caretCoords(el: TextField, index: number): { left: number; top: number; height: number } {
  const cs = window.getComputedStyle(el);
  const mirror = document.body.createDiv();
  const style = mirror.style as unknown as Record<string, string>;
  const computed = cs as unknown as Record<string, string>;
  for (const p of MIRROR_PROPS) style[p] = computed[p];
  style.position = "absolute";
  style.top = "0";
  style.left = "-9999px";
  style.visibility = "hidden";
  style.height = "auto";
  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";

  mirror.setText(el.value.slice(0, index));
  // Zero-width space: occupies a line box to measure, but no horizontal room,
  // so it can't shift the very position it is measuring.
  const marker = mirror.createSpan({ text: "​" });
  mirror.createSpan({ text: el.value.slice(index) });

  const left = marker.offsetLeft;
  const top = marker.offsetTop;
  const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 16;
  mirror.remove();

  return { left: left - el.scrollLeft, top: top - el.scrollTop, height };
}

/**
 * `/skill` autocomplete attached to a text input or textarea.
 *
 * Owns its own popup element, the caret-anchored positioning, and the keyboard
 * navigation. The host is responsible only for routing `keydown` in through
 * {@link SkillSuggest.handleKeydown} and reacting to `onPick`.
 */
export class SkillSuggest {
  private input: TextField;
  private skills: Skill[];
  private onPick: (skill: Skill | null) => void;
  private box: HTMLElement;

  /** Skills currently listed in the popup; empty means the popup is closed. */
  private suggestions: Skill[] = [];
  private activeIndex = 0;
  /** Offset of the `/` the popup is anchored to. */
  private tokenStart = 0;
  /** True when the current selection came from a `/token`, so deleting it clears. */
  private fromText = false;

  private listeners: Array<() => void> = [];
  private destroyed = false;

  /**
   * @param host - element the popup is positioned inside; must be `position: relative`
   * @param input - the field to watch
   * @param skills - candidate skills
   * @param onPick - called whenever the resolved skill changes, with null when it clears
   */
  constructor(
    host: HTMLElement,
    input: TextField,
    skills: Skill[],
    onPick: (skill: Skill | null) => void
  ) {
    this.input = input;
    this.skills = skills;
    this.onPick = onPick;
    this.box = host.createDiv({ cls: "skillwright-suggest" });
    this.box.hide();
  }

  /** True while the popup is showing, so a host can decide whether Escape is its own. */
  get isOpen(): boolean {
    return this.suggestions.length > 0;
  }

  /** Wires the field listeners. Call once, after construction. */
  attach(): void {
    const sync = () => this.syncFromText();
    for (const ev of ["input", "keyup", "click"] as const) {
      this.input.addEventListener(ev, sync);
      this.listeners.push(() => this.input.removeEventListener(ev, sync));
    }
    // Deferred so a mousedown on a suggestion row still lands first.
    const blur = () => window.setTimeout(() => this.close(), 100);
    this.input.addEventListener("blur", blur);
    this.listeners.push(() => this.input.removeEventListener("blur", blur));
  }

  /**
   * Offers a keystroke to the popup before the host handles it.
   *
   * @param e - the field's keydown event
   * @returns true if the popup consumed the key, in which case the host must not act on it
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.suggestions.length) return false;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.moveActive(1);
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.moveActive(-1);
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        this.accept(this.activeIndex);
        return true;
      case "Escape":
        // Stop it reaching the modal scope or the bar, either of which would
        // close outright when the user only meant to dismiss the popup.
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return true;
      default:
        return false;
    }
  }

  /** Re-reads the field after any edit: resolves `/tokens`, repaints the popup. */
  syncFromText(): void {
    const { skill } = resolveSkillToken(this.input.value, this.skills);
    if (skill) {
      this.fromText = true;
      this.onPick(skill);
    } else if (this.fromText) {
      // Deleting the token clears it, but a selection made elsewhere must survive typing.
      this.fromText = false;
      this.onPick(null);
    }

    const token = tokenAtCursor(this.input.value, this.input.selectionStart ?? 0);
    if (!token) {
      this.close();
      return;
    }
    this.tokenStart = token.start;
    this.open(matchSkills(token.query, this.skills).slice(0, MAX_SUGGESTIONS));
  }

  /**
   * Tells the popup that the skill was chosen somewhere else — a dropdown, say.
   * Without this it still believes it owns the selection, and the next edit that
   * leaves no `/token` behind would clear a pick it never made.
   */
  markExternalSelection(): void {
    this.fromText = false;
  }

  /** Hides the popup without touching the field or the selected skill. */
  close(): void {
    if (this.destroyed) return;
    this.suggestions = [];
    this.activeIndex = 0;
    this.box.hide();
  }

  /** Detaches every listener and removes the popup element. */
  destroy(): void {
    this.destroyed = true;
    for (const off of this.listeners) off();
    this.listeners = [];
    this.box.remove();
  }

  private open(matches: Skill[]): void {
    if (!matches.length) {
      this.close();
      return;
    }

    this.suggestions = matches;
    this.activeIndex = Math.min(this.activeIndex, matches.length - 1);
    this.box.empty();
    matches.forEach((s, i) => {
      const row = this.box.createDiv({ cls: "skillwright-suggest-item" });
      row.toggleClass("is-active", i === this.activeIndex);
      row.createDiv({ cls: "skillwright-suggest-name", text: skillSlug(s.name) });
      if (s.description) {
        row.createDiv({ cls: "skillwright-suggest-desc", text: s.description });
      }
      // mousedown, not click: the field's blur would close the popup first.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.accept(i);
      });
    });
    this.box.show();
    this.position();
  }

  /**
   * Anchors the popup under the `/` that opened it. Measured after the rows are
   * in the DOM, so the box's own width is known and can be clamped against the
   * field's right edge instead of spilling out of its container.
   */
  private position(): void {
    const el = this.input;
    const { left, top, height } = caretCoords(el, this.tokenStart);
    const maxLeft = Math.max(0, el.offsetWidth - this.box.offsetWidth);
    this.box.style.left = `${el.offsetLeft + Math.min(Math.max(left, 0), maxLeft)}px`;
    this.box.style.top = `${el.offsetTop + top + height + 4}px`;
  }

  private moveActive(delta: number): void {
    const n = this.suggestions.length;
    if (!n) return;
    this.activeIndex = (this.activeIndex + delta + n) % n;
    this.open(this.suggestions);
  }

  /** Splices `/<slug> ` over the token under the caret. */
  private accept(index: number): void {
    const el = this.input;
    const skill = this.suggestions[index];
    if (!skill) return;

    const token = tokenAtCursor(el.value, el.selectionStart ?? 0);
    if (!token) {
      this.close();
      return;
    }

    const insert = `/${skillSlug(skill.name)} `;
    el.value = el.value.slice(0, token.start) + insert + el.value.slice(token.end);
    const caret = token.start + insert.length;
    el.setSelectionRange(caret, caret);

    this.close();
    this.fromText = true;
    this.onPick(skill);
    el.focus();
  }
}
