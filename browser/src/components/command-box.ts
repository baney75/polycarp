/**
 * The look of a shell command the person copies: monospace on a muted box. It wraps anywhere
 * (`overflow-wrap:anywhere` also lowers the box's minimum width, which plain `break-words` does
 * not, so a long command can't push past the panel's edge) and keeps `--` as two hyphens.
 */
export const COMMAND_BOX_CLASS =
	"block min-w-0 max-w-full rounded-md border border-border bg-muted px-2.5 py-2 text-foreground font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] select-all [font-variant-ligatures:none]";
