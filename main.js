// Open a file in the current space. Bound to cmd+O: type to filter, up/down to
// choose, Enter to open, Esc to leave.
//
// How a file opens is not decided here. The Files panel publishes its own open
// action as the shared value "files.open", and this mod runs it, so whatever
// clicking a file in that panel does, cmd+O does too:
//
//   { command, args?, argv?, pathArg? }
//     command  an app command ("pane.split", "tab.new", ...)
//     args     its arguments
//     argv     the file's absolute path is appended to this argv
//     pathArg  or the path goes in args under this name ("file")
//
// With nothing published, OPEN below is used.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, props, closeOverlay, shared } from "herdr";

const OPEN = { command: "pane.split", args: { direction: "right" }, argv: ["nvim"] };

const MAX_FILES = 20000, MAX_ROWS = 300, ROW = 26, LIST_MAX = 390;
// A folder this mod is pointed at can be a whole home directory, so the shell's
// answer is cut off at a size worth reading rather than however large it grows.
const MAX_BYTES = 4 * 1024 * 1024;

// Only for folders that aren't a git repo: git's own ignore rules are better.
const SKIP = [".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
  "target", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "vendor",
  ".terraform", "Pods", ".gradle", ".idea", "DerivedData", ".pytest_cache",
  "Library", ".Trash", ".npm", ".nvm", ".cargo", ".rustup", ".m2"];

const LIST = `
cd "$1" 2>/dev/null || { echo "cannot read this folder" >&2; exit 1; }
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git --no-optional-locks -c core.fsmonitor=false ls-files -co --exclude-standard -z | head -c ${MAX_BYTES}
else
  find . -type d \\( ${SKIP.map((n) => `-name '${n}'`).join(" -o ")} \\) -prune -o -type f -print0 | head -c ${MAX_BYTES}
fi
`;

// Where the Files panel is looking: the focused pane's folder, else the space's.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

async function listFiles(root, on) {
  const r = await exec("sh", ["-c", LIST, "open-file", root], { on, timeout: 20000 });
  if (r.code !== 0) throw new Error((r.stderr || "cannot list this folder").trim());
  // Every entry ends in a NUL, so anything after the last one was cut in half.
  const whole = r.stdout.slice(0, r.stdout.lastIndexOf("\0") + 1);
  const paths = [], lower = [], cut = [];
  for (const path of whole.split("\0")) {
    const p = path.startsWith("./") ? path.slice(2) : path;
    if (!p) continue;
    paths.push(p);
    // Scoring reads these on every keystroke: build them once, not per search.
    lower.push(p.toLowerCase());
    cut.push(p.lastIndexOf("/"));
    if (paths.length >= MAX_FILES) break;
  }
  return { paths, lower, cut };
}

// A leftmost-first subsequence match, scored like a fuzzy finder: runs of
// adjacent letters, starts of path segments and words, and the file's own name
// all count for more, and shorter paths win ties.
// `from` is where matching starts: 0 for the whole path, or just past the last
// slash to score the file's own name, without slicing a string per file.
function score(path, q, from, slash) {
  let i = from, total = 0, prev = -2, run = 0;
  for (let k = 0; k < q.length; k += 1) {
    const at = path.indexOf(q[k], i);
    if (at < 0) return null;
    let bonus = 0;
    if (at === prev + 1) { run += 1; bonus += 8 + run * 2; } else run = 0;
    if (at === from || "/-_. ".includes(path[at - 1])) bonus += 10;
    if (at > slash) bonus += 6;
    total += 10 + bonus;
    prev = at; i = at + 1;
  }
  return total - Math.min(path.length - from, 240) * 0.08;
}

function rank(files, query) {
  const { paths, lower, cut } = files;
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return paths.slice(0, MAX_ROWS).map((path) => ({ path }));
  const hits = [];
  for (let i = 0; i < paths.length; i += 1) {
    const path = lower[i], slash = cut[i];
    const whole = score(path, q, 0, slash);
    const name = slash < 0 ? null : score(path, q, slash + 1, slash);
    const best = name === null ? whole : whole === null ? name + 40 : Math.max(whole, name + 40);
    if (best !== null) hits.push({ path: paths[i], score: best });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits.slice(0, MAX_ROWS);
}

export default class OpenFile extends View {
  init(_props, cx) {
    const { cwd, on } = location();
    this.root = cwd ? cwd.replace(/\/+$/, "") : null;
    this.on = on;
    this.files = null;
    this.error = null;
    this.filter = "";
    this.at = 0;
    this.shown = [];
    this.ranked = null;
    this.handle = cx.focus_handle();
    this.list = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Open a file…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.rerank();
      this.list.scroll_to_item(0);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.open(this.shown[this.at]?.path, cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.load(cx);
  }

  load(cx) {
    if (!this.root) return;
    cx.spawn(async (cx) => {
      try { this.files = await listFiles(this.root, this.on); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally { this.rerank(); cx.notify(); }
    });
  }

  // Herdr redraws a view whenever its live data moves — spaces, agents,
  // terminals, focus. Scoring every path on each of those redraws is what got
  // this view interrupted, so the list is ranked when the files or the query
  // change, and a redraw only reads the answer.
  rerank() {
    this.shown = this.files ? rank(this.files, this.filter) : [];
    this.ranked = this.filter;
    if (this.at >= this.shown.length) this.at = Math.max(0, this.shown.length - 1);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // The Files panel's own action, so a mod made there is respected here.
  open(rel) {
    if (!rel) return;
    const spec = shared("files.open") ?? OPEN;
    const args = { ...(spec.args ?? {}) };
    const path = `${this.root}/${rel}`;
    if (spec.pathArg) args[spec.pathArg] = path;
    else args.argv = [...(spec.argv ?? []), path];
    this.close();
    run(spec.command ?? OPEN.command, args);
  }

  move(by) {
    const n = this.shown.length;
    if (!n) return;
    this.at = by === 1 || by === -1 ? (this.at + by + n) % n : Math.max(0, Math.min(n - 1, this.at + by));
    this.list.scroll_to_item(this.at);
  }

  row(hit, i, t) {
    const slash = hit.path.lastIndexOf("/");
    const name = hit.path.slice(slash + 1), dir = slash < 0 ? "" : hit.path.slice(0, slash);
    const on = i === this.at;
    return h_flex().id(`of-${i}`).h(ROW).flex_none().px(9).gap(8).items_center().rounded(7).cursor_pointer()
      .when(on, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(hit.path))
      .child(svg("mods/open-file/file.svg").size(13).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().text_color(t.foreground).when(on, (d) => d.font_semibold()).child(name))
      .when(Boolean(dir), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir)));
  }

  render() {
    const t = theme();
    if (this.ranked !== this.filter) this.rerank();
    const total = this.files ? this.files.paths.length : 0;
    const note = this.error ? this.error
      : !this.root ? "This space has no folder"
      : this.files === null ? "Reading the folder…"
      : !total ? "No files here"
      : !this.shown.length ? "Nothing matches" : null;

    return v_flex().id("open-file").track_focus(this.handle).w_full().min_h(0).p(18).gap(10)
      .bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        const k = e.key, m = e.modifiers;
        if (k === "escape") return this.close();
        if (k === "down" || (k === "n" && m.control)) this.move(1);
        else if (k === "up" || (k === "p" && m.control)) this.move(-1);
        else if (k === "pagedown") this.move(10);
        else if (k === "pageup") this.move(-10);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().text_size(15).font_semibold().child("Open file"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.root ?? ""))
        .child(div().id("of-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/open-file/search.svg").size(15).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(note), (el) => el.child(div().px(9).py(6).text_size(12).text_color(t.dim).child(note)))
      .when(this.shown.length > 0, (el) => el.child(
        v_flex().id("of-list").h(Math.min(LIST_MAX, this.shown.length * ROW)).min_h(0)
          .overflow_y_scrollbar().track_scroll(this.list)
          .children(this.shown.map((hit, i) => this.row(hit, i, t)))))
      .when(this.shown.length > 0, (el) => el.child(
        h_flex().flex_none().px(9).gap(10).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().child(`${this.shown.length}${total > this.shown.length ? ` of ${total}` : ""} file${total === 1 ? "" : "s"}`))
          .child(div().flex_none().child("↑↓ choose · ⏎ open · esc close"))));
  }
}
