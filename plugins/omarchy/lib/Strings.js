.pragma library

// Every word the plugin shows, in one place. `%1` and `%2` are filled in by `fill`. A translation is another table with
// the same keys; a key it lacks falls back to English.
var en = {
  workspace: "Workspace %1",
  wantsYou: "wants you",
  moreApps: "+%1",
  layoutTiled: "Tiled. Click to change the layout",
  layoutScrolling: "Scrolling. Click to change the layout",
  layoutSingle: "One at a time. Click to change the layout",
  open: "Polycarp",
  agents: "Agents",
  agentsNeed: "%1 want you",
  agentsNeedOne: "1 wants you",
  agentsWorking: "%1 working",
  agentsQuiet: "%1 open",
  needsYou: "Needs you",
  working: "Working",
  openAgents: "Open",
  noAgents: "No coding agents are open.",
  drawerKeep: "Keep the drawer open",
  drawerClose: "Close the drawer",
  today: "Today",
  monthBefore: "The month before",
  monthAfter: "The next month",
  looks: "Looks",
  apps: "Apps",
  sync: "Sync",
  keys: "Keys",
  dark: "Dark",
  light: "Light",
  now: "In use",
  undo: "Undo",
  setting: "Setting it",
  pairMisses: "%1 on %2 reads %3 to 1. Small text needs %4.",
  looksLeft: "You changed this one in ~/.config/omarchy/themes, so it was left alone.",
  looksFailed: "Omarchy did not take that theme.",
  looksFont: "Omarchy keeps its own font.",
  undone: "Back to %1.",
  undoFailed: "There is nothing to undo.",
  fromOmarchy: "%1 for Polycarp",
  fromOmarchyHint: "Saves the Omarchy theme in use as a Polycarp theme, with its font and its background.",
  fitted: "Raised to 4.5 to 1: %1.",
  fittedOne: "%1 from %2",
  save: "Save",
  removeIt: "Remove",
  saved: "Saved in Polycarp's themes folder as %1.",
  saveLeft: "That theme is yours now, so it was left alone.",
  saveFailed: "It could not be saved.",
  removed: "Removed.",
  browser: "Browser",
  terminal: "Terminal",
  editor: "Editor",
  agent: "Coding agent",
  noChoice: "None is installed that Omarchy can set.",
  agentOpens: "Choosing a coding agent may open it.",
  appFailed: "Omarchy did not take that choice.",
  syncOff: "Not set up",
  syncText: "Polycarp Sync is not out yet. When it is, this is where you set up this computer and see what is in step.",
  keyArrows: "Move",
  keyEnter: "Choose",
  keyTab: "Next page",
  keyPages: "Go to a page",
  keyMode: "Dark or light looks",
  keyUndo: "Undo the last look",
  keySave: "Save the Omarchy theme",
  keyClose: "Close",
  keyOpen: "Open this from the keyboard",
  keyOpenText: "Put this in ~/.config/hypr/bindings.lua:",
  copy: "Copy",
  copied: "Copied"
}

var tables = { en: en }

function table(locale) {
  var lang = String(locale || "").split(/[_.-]/)[0]
  var own = tables[lang] || {}
  var out = {}
  for (var key in en) out[key] = own[key] !== undefined ? own[key] : en[key]
  return out
}

function fill(text, a, b) {
  return String(text).replace("%1", a === undefined ? "" : a).replace("%2", b === undefined ? "" : b)
}
