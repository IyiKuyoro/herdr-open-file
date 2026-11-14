# open-file

A file picker for [Herdr](https://herdr.app). Press **cmd+O**, type part of a file's
name, pick it with ↑/↓ and press Enter: the file opens exactly the way clicking it in
the Files panel opens it.

The picker searches the current space — the folder the focused pane is in, the same
folder the Files panel shows — and it searches on that space's machine, so a space on
a remote machine lists and opens files there.

## Install

```sh
git clone https://github.com/IyiKuyoro/herdr-open-file ~/.config/herdr-app/mods/open-file
```

The folder under `mods/` has to be called `open-file`: a mod is named after its
folder, and the mod's icons are loaded from `mods/open-file/`.

Then bind a key in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "cmd-o": "mod.open:open-file" } }
```

Herdr picks both up straight away; no restart.

## How a file opens

The mod does not decide. It reads the shared value `files.open` and runs it, so
whatever the Files panel does on a click, cmd+O does too:

```js
// in your files mod's init()
setShared("files.open", {
  command: "pane.split",              // any app command
  args: { direction: "right" },       // its arguments
  argv: ["/opt/homebrew/bin/nvim"],   // the file's absolute path is appended
});
```

Use `pathArg: "file"` instead of `argv` when the command takes the path as a named
argument, for example opening a viewer mod in a new tab:

```js
setShared("files.open", { command: "tab.new", args: { mod: "files" }, pathArg: "file" });
```

With nothing published, the mod falls back to splitting a pane to the right running
`nvim <file>`. Change `OPEN` at the top of `main.js` to pick a different default.

## What it lists

- In a git repository: `git ls-files -co --exclude-standard`, so ignored files stay out.
- Anywhere else: `find`, skipping `.git`, `node_modules`, `dist`, `build` and other
  build and cache folders (the `SKIP` list in `main.js`).

Up to 20,000 files are read when the picker opens and filtered in memory as you type,
so typing never waits on the disk. Reopen it to pick up new files.

Matching is a fuzzy subsequence over the whole path, scoring runs of adjacent letters,
starts of path segments and matches in the file's own name — `mdl/usr` finds
`src/modules/user/index.ts`.

## Keys

| | |
|---|---|
| ↑ / ↓, ctrl+p / ctrl+n | move |
| page up / page down | move ten |
| Enter | open |
| Esc | close |

## Requirements

Herdr with `sh`, `git` and `find` on the machine the space lives on — macOS and Linux
today. Windows spaces are not supported yet.
