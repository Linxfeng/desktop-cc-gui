/**
 * Tree-local keys: they act only while focus is inside the tree, and are
 * surfaced by the root row's hover actions' tooltips.
 *
 * Shared here because the handlers live in `FileTree` (keydown) while the
 * buttons live in `FileTreeRow` (root-row actions); keeping the strings in
 * one module avoids importing `FileTree` from the row and cycling back.
 */
export const EXPAND_LOADED_SHORTCUT = "alt+shift+arrowright";
export const COLLAPSE_ALL_SHORTCUT = "alt+shift+arrowleft";
