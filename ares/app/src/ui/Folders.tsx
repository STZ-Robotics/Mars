import { ReactNode, useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

// Folders for the paths and the autos. What each
// item is in lives on the item (its `folder`); folders.json keeps the
// folders themselves, so an empty one stays.

/** What a path or an auto dragged onto a folder carries: its name. */
export const ITEM_MIME = "application/x-ares-item"

interface FoldersDoc { paths: string[]; autos: string[] }

export function useFolders(robotPath: string, kind: keyof FoldersDoc) {
  const [doc, setDoc] = useState<FoldersDoc>({ paths: [], autos: [] })
  const [closed, setClosed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`ares.closedFolders:${kind}`) ?? "[]")) } catch { return new Set() }
  })
  useEffect(() => {
    invoke<FoldersDoc>("folders_open", { robotPath }).then(setDoc).catch(() => {})
  }, [robotPath])
  const save = useCallback((list: string[]) => {
    setDoc(d => {
      const next = { ...d, [kind]: list }
      invoke("folders_save", { robotPath, folders: next }).catch(() => {})
      return next
    })
  }, [robotPath, kind])
  const toggle = (name: string) => setClosed(c => {
    const n = new Set(c)
    if (n.has(name)) n.delete(name); else n.add(name)
    try { localStorage.setItem(`ares.closedFolders:${kind}`, JSON.stringify([...n])) } catch { /* not remembered */ }
    return n
  })
  return { folders: doc[kind], save, open: (name: string) => !closed.has(name), toggle }
}

/**
 * The folders to show, in order: the saved ones, then any an item names that
 * the file lost; each with its items. And the items in no folder.
 */
export function groupByFolder<T>(items: T[], folderOf: (t: T) => string | undefined, folders: string[]): { groups: [string, T[]][]; loose: T[] } {
  const names = [...folders]
  for (const t of items) { const f = folderOf(t); if (f && !names.includes(f)) names.push(f) }
  return {
    groups: names.map(f => [f, items.filter(t => folderOf(t) === f)]),
    loose: items.filter(t => !folderOf(t)),
  }
}

/** A folder's row: open or closed, items dropped on it go in, double-click renames. */
export function FolderRow({ name, count, open, onToggle, onDropItem, onRename, onDelete }: {
  name: string; count: number; open: boolean; onToggle: () => void
  onDropItem: (item: string) => void; onRename: (to: string) => void; onDelete: () => void
}) {
  const [over, setOver] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(name)
  useEffect(() => setText(name), [name])
  return (
    <div
      onClick={() => !editing && onToggle()}
      onDoubleClick={e => { e.stopPropagation(); setEditing(true) }}
      onDragOver={e => { if (e.dataTransfer.types.includes(ITEM_MIME)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const item = e.dataTransfer.getData(ITEM_MIME); if (item) onDropItem(item) }}
      title="Drop paths here to put them in it. Double-click to rename."
      style={{
        display: "flex", alignItems: "center", gap: 6, height: 26, padding: "0 6px 0 8px", fontSize: 12, cursor: "pointer", userSelect: "none",
        borderBottom: "1px solid var(--border-light)", background: over ? "rgba(233,84,32,0.12)" : "var(--bg-panel)",
        outline: over ? "1px dashed #e95420" : "none", outlineOffset: -1,
      }}>
      <i className={`ti ti-chevron-right ares-chevron${open ? " open" : ""}`} style={{ fontSize: 12, color: "var(--text-muted)" }} />
      <i className={`ti ${open ? "ti-folder-open" : "ti-folder"}`} style={{ fontSize: 15, color: "#ca8a04" }} />
      {editing ? (
        <input autoFocus value={text} onClick={e => e.stopPropagation()} onChange={e => setText(e.target.value)}
          onFocus={e => e.target.select()}
          onBlur={() => { setEditing(false); const v = text.trim(); if (v && v !== name) onRename(v); else setText(name) }}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setText(name); setEditing(false) } }}
          style={{ flex: 1, fontSize: 12, height: 20, border: "1px solid var(--border-dark)", padding: "0 4px" }} />
      ) : (
        <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      )}
      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{count}</span>
      <button title="Delete the folder (what is in it stays, outside it)" onClick={e => { e.stopPropagation(); onDelete() }}
        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: "0 2px" }}>
        <i className="ti ti-x" style={{ fontSize: 12 }} />
      </button>
    </div>
  )
}

/** Where items dropped leave their folder. */
export function LooseDrop({ onDropItem, children }: { onDropItem: (item: string) => void; children: ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={e => { if (e.dataTransfer.types.includes(ITEM_MIME)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); const item = e.dataTransfer.getData(ITEM_MIME); if (item) onDropItem(item) }}
      style={{ outline: over ? "1px dashed #e95420" : "none", outlineOffset: -1, minHeight: 6 }}>
      {children}
    </div>
  )
}

/** The name for a new folder: "New folder", "New folder 2"... */
export function newFolderName(taken: string[]): string {
  let name = "New folder"
  for (let i = 2; taken.includes(name); i++) name = `New folder ${i}`
  return name
}
